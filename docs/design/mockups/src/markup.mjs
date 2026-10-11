const I = {
  plus:'<path d="M12 5v14M5 12h14"/>',
  search:'<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon:'<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  globe:'<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  file:'<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  check:'<path d="m5 12 5 5L20 7"/>',
  chev:'<path d="m9 6 6 6-6 6"/>',
  send:'<path d="M12 19V5M5 12l7-7 7 7"/>',
  clip:'<path d="m21 11-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7"/>',
  monitor:'<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  pause:'<path d="M9 5v14M15 5v14"/>',
  hand:'<path d="M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8a8 8 0 0 0 16 0v-3a2 2 0 0 0-4 0"/>',
  mail:'<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  spark:'<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
  menu:'<path d="M4 7h16M4 12h16M4 17h16"/>',
  more:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  brain:'<path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 3 3h0a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zM15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-3 3 2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/>',
  bolt:'<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  dl:'<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  x:'<path d="M6 6l12 12M18 6 6 18"/>',
  expand:'<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
  cpu:'<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
};
export const ic = (n, c='') => `<svg class="ic ${c}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${I[n]}</svg>`;

const agents = [
  { id:'a1', n:'小洛', ch:'洛', d:'全能助理 · 正在工作', on:true, c:'av1' },
  { id:'a2', n:'阿维', ch:'维', d:'写代码、跑脚本', c:'av2' },
  { id:'a3', n:'研究员', ch:'研', d:'资料检索与报告', c:'av3' },
];

export function markup(styleLabel) {
  const agentList = agents.map((a,i)=>`
    <button class="agent ${i===0?'active':''}" data-agent="${a.id}">
      <span class="av ${a.c}">${a.ch}${a.on?'<i class="dot"></i>':''}</span>
      <span class="agent-txt"><b>${a.n}</b><small>${a.d}</small></span>
      ${i===0?'<span class="badge">2</span>':''}
    </button>`).join('');
  const steps = [
    ['打开 3 家竞品官网定价页','3.2 秒'],
    ['提取套餐名称、价格、席位上限','6.8 秒'],
    ['对比上周快照，标记 5 处变化','2.1 秒'],
    ['生成 Excel 表格并写入摘要','4.4 秒'],
  ];
  return `
<div class="bg-layer" aria-hidden="true"><i class="b1"></i><i class="b2"></i><i class="b3"></i></div>
<div class="app">
  <aside class="sidebar">
    <div class="brand">
      <span class="logo">π</span><span class="brand-name">Pi Assistant</span>
      <button class="icon-btn ghost theme-toggle" title="切换主题">${ic('sun','i-sun')}${ic('moon','i-moon')}</button>
    </div>
    <button class="new-btn">${ic('plus')}<span>新建助理</span><kbd>⌘N</kbd></button>
    <div class="search">${ic('search')}<span>搜索对话与文件</span><kbd>⌘K</kbd></div>
    <div class="sec-label">我的助理</div>
    <nav class="agents">${agentList}</nav>
    <div class="sec-label">最近对话</div>
    <div class="threads">
      <a class="thread active">竞品定价周报</a>
      <a class="thread">整理九月发票</a>
      <a class="thread">给团队发周会纪要</a>
      <a class="thread">家里路由器设置</a>
    </div>
    <div class="side-foot">
      <span class="me">D</span><span class="me-txt"><b>deng</b><small>本机 · MacBook Pro</small></span>
      <span class="conn"><i></i>已连接</span>
    </div>
  </aside>

  <main class="chat">
    <header class="chat-head">
      <button class="icon-btn ghost m-only">${ic('menu')}</button>
      <span class="av av1 sm">洛<i class="dot"></i></span>
      <div class="head-txt"><b>小洛</b><small><i class="pulse"></i>工作中 · Claude Sonnet</small></div>
      <div class="head-actions">
        <button class="icon-btn ghost theme-toggle m-only" title="切换主题">${ic('sun','i-sun')}${ic('moon','i-moon')}</button>
        <button class="chip">${ic('monitor')}<span>电脑</span></button>
        <button class="icon-btn ghost">${ic('more')}</button>
      </div>
    </header>

    <div class="scroll">
      <div class="thread-body">
        <div class="day">今天 18:20</div>

        <div class="msg user"><div class="bubble">帮我看一下这周 3 家竞品的定价有没有变化，整理成表格，然后发给团队邮箱。</div></div>

        <div class="msg bot">
          <span class="av av1 xs">洛</span>
          <div class="bot-body">
            <div class="bubble">好，我先看一下。</div>

            <div class="activity"><span class="spinner"></span>${ic('globe')}<span class="act-txt"><span class="shimmer">正在打开网页…</span></span><span class="act-url">pricing.notion.so</span></div>

            <div class="steps">
              <button class="steps-head">${ic('check','ok')}<span>已完成 4 个步骤</span><small>用时 16.5 秒</small>${ic('chev','chev')}</button>
              <ol class="steps-list">${steps.map(s=>`<li><i class="st-dot">${ic('check')}</i><span>${s[0]}</span><small>${s[1]}</small></li>`).join('')}</ol>
            </div>

            <div class="bubble prose">整理好了，这周有 <b>5 处</b>变化，最大的是 Notion 团队版从 ¥72 涨到 ¥80。表格在下面：</div>

            <div class="card file-card">
              <span class="file-ic">${ic('file')}<em>XLSX</em></span>
              <span class="file-txt"><b>竞品定价对比_2026W41.xlsx</b><small>24 KB · 3 个工作表 · 5 处变化已高亮</small></span>
              <button class="icon-btn">${ic('dl')}</button>
            </div>

            <div class="card approval" id="approval">
              <div class="card-top">${ic('mail','warn')}<b>需要你批准</b><span class="tag">发送邮件</span></div>
              <div class="kv"><span>收件人</span><b>team@dengdengyun.shop</b></div>
              <div class="kv"><span>主题</span><b>竞品定价周报 · 第 41 周</b></div>
              <div class="kv"><span>附件</span><b>竞品定价对比_2026W41.xlsx</b></div>
              <div class="actions">
                <button class="btn ghost" data-act="reject">拒绝</button>
                <button class="btn ghost" data-act="edit">修改</button>
                <button class="btn primary" data-act="approve">${ic('check')}批准发送</button>
              </div>
              <div class="result"></div>
            </div>

            <div class="card question" id="question">
              <div class="card-top">${ic('spark','accent')}<b>以后每周都要这样做吗？</b></div>
              <div class="opts">
                <button class="opt">每周一 9:00 自动跑<small>推荐</small></button>
                <button class="opt">每周五下班前</button>
                <button class="opt">不用，这次就够了</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="composer-wrap">
      <div class="composer">
        <div class="composer-input" contenteditable="true" data-ph="给小洛布置任务，或输入 / 使用技能…"></div>
        <div class="composer-bar">
          <button class="icon-btn ghost">${ic('clip')}</button>
          <button class="chip sm">${ic('bolt')}<span>技能</span></button>
          <button class="chip sm">${ic('monitor')}<span>助理电脑</span></button>
          <span class="flex"></span>
          <span class="model">Claude Sonnet</span>
          <button class="send">${ic('send')}</button>
        </div>
      </div>
      <div class="foot-note">发送、删除、付款等操作都会先请你批准</div>
    </div>
  </main>

  <aside class="pane">
    <section class="ov">
      <span class="av av1 lg">洛<i class="dot"></i></span>
      <h2>小洛</h2>
      <p>你的全能助理，擅长调研、整理资料和操作电脑。</p>
      <div class="stats">
        <div><b>128</b><small>完成任务</small></div>
        <div><b>36</b><small>条记忆</small></div>
        <div><b>9</b><small>个技能</small></div>
      </div>
    </section>
    <section class="pc">
      <div class="pane-label">${ic('monitor')}<span>助理的电脑</span><span class="live"><i></i>实时</span></div>
      <div class="screen">
        <div class="desk">
          <div class="win">
            <div class="win-bar"><i></i><i></i><i></i><span>pricing.notion.so</span></div>
            <div class="win-body">
              <div class="sk w60"></div><div class="sk w40"></div>
              <div class="cols"><div class="col"><div class="sk w50"></div><div class="price">¥0</div></div><div class="col hl"><div class="sk w50"></div><div class="price">¥80</div></div><div class="col"><div class="sk w50"></div><div class="price">¥120</div></div></div>
            </div>
          </div>
          <div class="taskbar"><i></i><i></i><i></i><i></i></div>
          <svg class="cursor" viewBox="0 0 24 24"><path d="M5 3l14 8-6 2-3 6z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>
          <span class="ripple"></span>
        </div>
      </div>
      <div class="pc-actions">
        <button class="btn ghost sm">${ic('hand')}接手</button>
        <button class="btn ghost sm">${ic('pause')}暂停</button>
        <button class="btn ghost sm">${ic('expand')}全屏</button>
      </div>
    </section>
    <section class="info">
      <div class="pane-label"><span>设置</span></div>
      <div class="row">${ic('cpu')}<span>模型</span><b>Claude Sonnet</b></div>
      <div class="row">${ic('brain')}<span>记忆</span><b>已开启</b></div>
      <div class="row">${ic('clock')}<span>定时任务</span><b>2 个</b></div>
      <div class="row">${ic('monitor')}<span>控制本机</span><b class="off">已关闭</b></div>
    </section>
  </aside>
</div>
<div class="style-tag">${styleLabel}</div>`;
}

export const script = `
(function(){
  var q=new URLSearchParams(location.search), root=document.documentElement;
  var t=q.get('theme')||localStorage.getItem('pa-theme')||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');
  root.dataset.theme=t;
  document.querySelectorAll('.theme-toggle').forEach(function(b){b.onclick=function(){
    root.dataset.theme=root.dataset.theme==='dark'?'light':'dark';localStorage.setItem('pa-theme',root.dataset.theme);};});
  document.querySelector('.steps-head').onclick=function(){this.parentNode.classList.toggle('open');};
  document.querySelectorAll('.agent').forEach(function(a){a.onclick=function(){
    document.querySelectorAll('.agent').forEach(function(x){x.classList.remove('active')});a.classList.add('active');};});
  document.querySelectorAll('.thread').forEach(function(a){a.onclick=function(){
    document.querySelectorAll('.thread').forEach(function(x){x.classList.remove('active')});a.classList.add('active');};});
  var ap=document.getElementById('approval');
  ap.querySelectorAll('[data-act]').forEach(function(b){b.onclick=function(){
    var act=b.dataset.act, r=ap.querySelector('.result');
    if(act==='edit'){document.querySelector('.composer-input').focus();return;}
    ap.classList.add(act==='approve'?'approved':'rejected');
    r.innerHTML=act==='approve'?'<span class="res ok">✓ 已批准 · 邮件已发送给 team@dengdengyun.shop</span>':'<span class="res no">已拒绝 · 小洛不会发送这封邮件</span>';
  };});
  document.querySelectorAll('.opt').forEach(function(o){o.onclick=function(){
    document.querySelectorAll('.opt').forEach(function(x){x.classList.remove('picked')});o.classList.add('picked');};});
  var acts=['正在打开网页…','正在读取定价表…','正在对比上周快照…','正在生成表格…'],i=0;
  if(!q.get('static')) setInterval(function(){i=(i+1)%acts.length;var s=document.querySelector('.shimmer');s.textContent=acts[i];},2600);
  var mb=document.querySelector('.chat-head .m-only');mb&&(mb.onclick=function(){document.body.classList.toggle('side-open')});
})();`;
