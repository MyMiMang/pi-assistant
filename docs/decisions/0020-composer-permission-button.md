# 0020 输入栏「技能」按钮换成「权限」按钮
- 日期：2026-10-22
- 状态：有效
- 决定：单聊输入栏原来的「技能」按钮（这条消息手动指定用某个技能）去掉，原位置换成「权限」按钮：显示这个助理操作你电脑的档位，点开就地切换（和 助理设置 › 电脑 › 操作你的电脑 是同一块内容），可去全局电脑设置。
- 原因：用户找不到每个助理的权限设置，希望在输入栏直接看到、直接切；手动指定技能用得少，助理启用的技能本来就会按需自己用。
- 不做什么：不保留技能按钮，也不收进「更多」菜单（用户选「直接换掉」）。服务端发消息接口的 `skills` 参数暂时保留（只是不再有界面入口）。
- 影响：`HostControl.tsx` 的 `HostTierButton`、`Chat.tsx`；删 `SkillPicker.tsx`、`skillDrafts.ts`；e2e `composer-permission-ui.mjs`（原 `skill-pick-ui.mjs`）；[design/context-compact-skill-pick.md](../design/context-compact-skill-pick.md) 的「本次选用技能」部分废弃。
