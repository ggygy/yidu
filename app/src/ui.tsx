// v0.3 §2.7 原生控件(三窗共用):分段控件、工具栏图标按钮、开关、确认卡、设置分组行
import React from "react";
import { Icon } from "./icons";

export function Segmented<T extends string>({ value, options, onChange, className }: {
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div className={"seg " + (className ?? "")} role="group">
      {options.map(([v, label]) => (
        <button key={v} aria-pressed={value === v} onClick={() => onChange(v)}>{label}</button>
      ))}
    </div>
  );
}

export function TbButton({ icon, title, active, onClick, disabled, size = 15 }: {
  icon: string;
  title: string;
  active?: boolean;
  onClick: () => void;
  disabled?: boolean;
  size?: number;
}) {
  return (
    <button className="tbtn" title={title} aria-label={title} aria-pressed={active} disabled={disabled} onClick={onClick}>
      <Icon n={icon} size={size} />
    </button>
  );
}

/** 开关:开 = 强调色(§2.7 控件规范) */
export function Toggle({ on, onClick, disabled }: { on: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      className={"relative w-[30px] h-[18px] rounded-full border-none shrink-0 transition-colors duration-150 disabled:opacity-40 " + (on ? "bg-accent" : "bg-fill2")}
      onClick={onClick}
      disabled={disabled}
      role="switch"
      aria-checked={on}
    >
      <i className={"absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.3)] transition-[left] duration-150 " + (on ? "left-[14px]" : "left-[2px]")} />
    </button>
  );
}

/** 应用内确认小卡(替代 window.confirm) */
export function ConfirmCard({ title, body, confirmText, onConfirm, onClose }: {
  title: string;
  body?: string;
  confirmText: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <>
      <div className="fixed inset-0 bg-scrim z-[80] [animation:fadein_0.15s]" onClick={onClose} />
      <div className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[300px] bg-surface rounded-xl shadow-[var(--shadow-card)] p-4 z-[90]" onClick={(e) => e.stopPropagation()}>
        <b className="text-[13px] font-semibold">{title}</b>
        {body && <p className="text-[12px] text-t2 mt-1.5 mb-0 break-all leading-normal">{body}</p>}
        <div className="flex justify-end gap-2 mt-4">
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" onClick={() => { onConfirm(); onClose(); }}>{confirmText}</button>
        </div>
      </div>
    </>
  );
}

/** 设置分组:可选组标题 + 行 + 脚注 */
export function Group({ title, foot, children }: { title?: string; foot?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mb-4">
      {title && <div className="gh">{title}</div>}
      <div className="gl">{children}</div>
      {foot && <div className="gf">{foot}</div>}
    </section>
  );
}

export function Row({ label, children, danger, title }: { label: React.ReactNode; children?: React.ReactNode; danger?: boolean; title?: string }) {
  return (
    <div className="gr" title={title}>
      <span className={"whitespace-nowrap " + (danger ? "text-danger" : "")}>{label}</span>
      <span className="v">{children}</span>
    </div>
  );
}

export function prettyAccel(a: string): string {
  return a.replace("CommandOrControl", "⌘").replace("Alt", "⌥").replace("Shift", "⇧").replace("Control", "⌃").replace(/\+/g, "");
}

export function fmtTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}
