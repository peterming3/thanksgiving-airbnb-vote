import { useState } from 'react';
import { useSession } from '../session/SessionContext.jsx';

// 绑邮箱提醒：没绑邮箱的人每次登录成功后弹一次（关掉就等下次登录再弹，
// 绑上为止）。刷新页面恢复会话不算登录，不弹。登录一完成立刻弹，不做
// 延迟等待。"现在绑邮箱"直接打开登录框的绑邮箱那一步。
export default function BindNag() {
  const { name, users, loginTick, loginOpen, openBind } = useSession();
  const [dismissedTick, setDismissedTick] = useState(0);
  const me = name ? users.find(u => u.name === name) : null;
  const shouldNag = !!me && !me.emailBound && loginTick > 0 && dismissedTick < loginTick && !loginOpen;

  if (!shouldNag) return null;
  const dismiss = () => setDismissedTick(loginTick);
  const bindNow = () => { dismiss(); openBind(); };

  return (
    <div className="login-fade fixed inset-0 bg-slate-950/45 backdrop-blur-[3px] flex items-center justify-center z-[60] px-4"
      onClick={e => { if (e.target === e.currentTarget) dismiss(); }}>
      <div className="login-pop glass-sheet relative rounded-[28px] px-6 py-6 w-full max-w-sm"
        role="alertdialog" aria-modal="true" aria-label="绑定邮箱提醒">
        <div className="flex items-center gap-3.5">
          <span className="grid h-[52px] w-[52px] shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 text-[26px] shadow-[0_8px_20px_-6px_rgba(99,60,235,.6),inset_0_1px_0_rgba(255,255,255,.4)]">📮</span>
          <h3 className="text-xl font-extrabold leading-tight">「{name}」还没绑邮箱</h3>
        </div>
        <button onClick={bindNow} className="btn-primary mt-5 w-full rounded-xl px-5 py-3 font-bold">现在绑邮箱</button>
        <button onClick={dismiss} className="mt-2.5 w-full text-center text-sm font-medium text-slate-400 transition hover:text-slate-600">下次再说（下次登录还会提醒你 😏）</button>
      </div>
    </div>
  );
}
