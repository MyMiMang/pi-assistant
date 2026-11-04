状态：已批准（2026-11-05，决策 [0028](../decisions/0028-tier-enables-host-control.md)）

# 给助理设档位就能用：「操作这台电脑」开启流程简化

## 1. 问题（用户原话：「给了完全权限为什么用不了」「搞这么复杂用户一下子就弃坑了」）
现在开启要走两条互不相干的路：
1. 助理档位（`TierPicker`，在 助理详情 › 电脑 和 输入栏「权限」按钮）：调高时弹风险确认，**只改档位**；
2. 总开关（设置 › 操作这台电脑）：再审阅一遍权限计划、勾「我已阅读…」、点「确认开启」。

所以用户给助理设了完全权限、确认过风险，还是「未开启」。更糟的是：只要允许名单里**任何一个**助理是「限定」又没选应用，设置页的开启按钮就整个变灰（`HostControl.tsx` 的 `disabled={busy || (anyBounded && !apps.length)}`），服务端也拒（`routes/host-control.ts` 里「“限定”档位至少要选择一个允许操作的应用」），而且不告诉用户为什么。

## 2. 改成什么样（只改这三件事，别的都不动）
**A. 在助理档位里选档位 = 开启。** 总开关没开时，在 `TierPicker` 里选任何一个档位（包括「只看」「限定」和当前显示的那个），都弹一次风险确认；确认后服务端同时：设这个助理的档位、把它加进允许名单（名单是 `"all"` 就不用加）、开启「操作这台电脑」、启动守护进程。完全权限照旧是红色「确定启用」那张（`FULL_ASK`）。

**B. 「限定」没选应用的助理不再挡住别人。** 这样的助理暂时不能操作（不给它挂电脑工具，不为它起限定守护进程），在它的档位那里提示一句；**不能**把它当成「只看」（只看能看所有应用，等于放大权限）。

**C. 文字说清楚。** 没开启时，助理档位那里不再说「在 设置 › 操作这台电脑 开启」，改成「还没开启：选一个档位就会开启」。

设置页的总开关流程（审阅计划 → 勾同意 → 确认开启）保留，作为批量设置的入口；去掉它的变灰条件 `anyBounded && !apps.length`。

## 3. 服务端：`packages/server/src/host-control.ts`
3.1 新增一个导出函数，放在 `tierOf` 下面：
```ts
/** 「限定」档还没选任何应用：这个助理暂时不能操作（不挂电脑工具、不为它起限定守护进程）。不要把它当「只看」——那会放大权限 */
export const boundedWithoutApps = (agentId: string, s = hostSettings()) => tierOf(agentId, s) === "bounded" && !s.apps.length;
```
3.2 `neededDaemons`：过滤掉 `boundedWithoutApps(a, s)` 的助理再算：
```ts
export const neededDaemons = (s = hostSettings()): DaemonKind[] => [...new Set(allowedAgents(s).filter((a) => !boundedWithoutApps(a, s)).map((a) => daemonKindOf(tierOf(a, s))))].sort();
```
3.3 `hostAllowedFor`：加一条 `&& !boundedWithoutApps(agentId, s)`。
3.4 `hostPlan`：列各助理档位那一行，`boundedWithoutApps` 的写成 `# - <id>: 限定（还没选应用，暂时不能操作）`；`if (ids.some(... === "bounded"))` 那句（追加 boundedManifest）改成只在「有限定档且 `s.apps.length > 0`」时追加。
3.5 文件现在 560 行，改完不能超过 600 行。

## 4. 服务端：`packages/server/src/routes/host-control.ts`
4.1 `PUT /api/host-control`（设置页开启）：删掉这一行
`if (ids.some((a) => tierOf(a, next) === "bounded") && !next.apps.length) return c.json({ error: "“限定”档位至少要选择一个允许操作的应用" }, 400);`
4.2 `PUT /api/host-control/tier/:agentId`（助理档位）改成：
- 计算 `const enabling = !cur.enabled || !(cur.agents === "all" || cur.agents.includes(agentId));`（总开关没开，或这个助理不在名单里 = 这次是在「开启」）
- 风险确认：原来是 `RANK[b.tier] > RANK[from] && !b.acknowledged` 才拒；改成 `(enabling || RANK[b.tier] > RANK[from]) && !b.acknowledged` 就拒，错误文案「开启前需要先确认风险提示」/ 原文案。
- 完全权限：原来是 `b.tier === "full" && from !== "full" && !fullConfirmed(b)`；改成 `b.tier === "full" && (from !== "full" || enabling) && !fullConfirmed(b)`。
- 删掉这一行：`if (b.tier === "bounded" && !cur.apps.length && cur.enabled) return c.json({ error: ... }, 400);`（限定没选应用现在是允许的，只是暂时不能操作）
- fullAck 逻辑不变。保存档位时：如果 `enabling`，同一次 `saveHostSettings` 里还要写 `enabled: true`、`enabledAt: Date.now()`、`agents: cur.agents === "all" ? "all" : [...new Set([...cur.agents, agentId])]`。
- 然后算 `yaml = hostManifest()`；**只要现在是开启状态**（原来已开启，或这次 `enabling` 开启了），就 `saveHostSettings({ approvedHash: manifestHash(yaml) })` 再 `startDaemon(yaml)`（沿用现有的 try/catch 和返回值）。
- 返回值加一个字段 `enabled: true/false`（开启后的状态）和 `note`：如果 `boundedWithoutApps(agentId)` 为真，`note` 是「“限定”档位还没选应用，这个助理暂时不能操作：到 设置 › 操作这台电脑 里选应用」，否则不带。
4.3 两处 import 补上 `boundedWithoutApps`。

## 5. 前端：`apps/web/src/components/HostControl.tsx`（现在 509 行，不能超过 600）
5.1 设置页开启按钮：`disabled={busy || (anyBounded && !apps.length)}` 改成 `disabled={busy}`。在按钮那一行（`host-autosave` 旁边）加一句提示，条件是 `anyBounded && !apps.length`：
`<span className="text-xs text-mut" data-testid="host-bounded-hint">「限定」档的助理还没选应用，开启后它们暂时不能操作</span>`
5.2 `TierPicker` 新增一个参数 `on: boolean`（= 总开关开着且这个助理在名单里，调用处用 `tierFor(d, agentId) !== null` 算）：
- `on` 为 false 时：所有档位按钮都不显示为选中（`aria-pressed={on && cur === t}`，选中样式也用 `on && cur === t`）；`pick(t)` 不再判断 `t === cur` 和「调低直接生效」，**一律先弹确认**：完全权限用 `FULL_ASK`，其他用 `{ title: \`开启并设为「${label}」？\`, body: \`${desc}。这会同时开启「操作这台电脑」，随时可以一键暂停。受保护的操作仍会先问你。\`, ok: "开启" }`；确认后 `apply(t, true)`。
- `on` 为 true 时：行为和现在完全一样。
- `apply` 拿到返回值后：有 `r.note` 就在「已保存」的位置显示 `r.note`（用 `text-amber-600`），没有就照旧显示「已保存」。
5.3 `AgentHostTierView`：`（未开启，在 设置 › 操作这台电脑 开启）` 改成 `（还没开启：选一个档位就会开启）`；`（这个助理不在允许名单里）` 改成 `（这个助理还没开：选一个档位就会开启）`。助理在名单里、总开关开着、但 `boundedWithoutApps`（前端判断：`cur === "bounded" && !d.settings.apps.length`）时，在标题后面加 `（「限定」还没选应用，暂时不能操作）`。
5.4 `HostTierButton` 不用改（它读 `tierFor`，开启后自然显示档位）。

## 6. 测试
6.1 单测 `packages/server/test/host-control.test.ts` 末尾加 3 个（照这个文件现有的写法 import 和准备设置）：
- 「限定档没选应用：neededDaemons 不含 bounded、hostAllowedFor 为 false、计划里写“暂时不能操作”；选了应用后恢复」
- 「限定档没选应用不挡开启：允许名单里有限定没选应用的助理，另一个是完全权限，PUT /api/host-control 开启成功」——这个文件如果没有起 HTTP 的例子，就只测 3.x 的函数，路由行为放进 e2e。
- 如果文件里能调路由（搜一下 `mountHostControlRoutes` / `app.request`），再加：「总开关没开时 PUT tier/:id {tier:"full", acknowledged:true, confirmFull:true} → enabled 为 true、名单含这个助理；不带 acknowledged → 400」。
6.2 e2e（只改这两个文件里受影响的断言，Mock + 临时数据，用 `PIA_HOST_CONTROL_DRY_RUN=1` 的现有做法）：
- `e2e/composer-permission-ui.mjs`：没开启时按钮仍显示「权限·未开启」；点开菜单的说明文字改成新文案；在菜单里点「完全权限」→ 确认 → 按钮变成「权限·完全权限」，**不需要**再去设置页。
- `e2e/settings-usability-ui.mjs`：原有「审阅 → ack → 确认开启」流程照旧能走通；新增一条：有限定档没选应用的助理时，「查看权限清单并开启…」按钮不是灰的，`host-bounded-hint` 可见。
- 跑法：`E2E_ONLY='composer-permission|settings-usability' npm run e2e`（如果 E2E_ONLY 认的是别的名字，看 `e2e/run.mjs` 里这两个脚本的步骤名）。

## 7. 不要做的事
- 不要去掉风险确认；不要把「限定没选应用」当成「只看」。
- 不要改 Pi、node_modules、依赖版本；不要 commit / push。
- 不要改 设置页总开关的「审阅计划 → 勾同意 → 确认开启」那套（只去掉变灰条件）。
