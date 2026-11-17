// 方向选择器(主窗设置/composer + 快捷窗共用):两个语言下拉 + 交换;下拉含「其他…」自定义
import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import { LANGS, encodeCustomName, langZh, makeDir, splitDir } from "./languages";

const SELECT_CLS =
  "field !h-[22px] !text-[12px] !px-1 max-w-[110px]";

function SegSelect({ seg, onSeg }: { seg: string; onSeg: (s: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) ref.current?.focus(); }, [editing]);

  const commit = () => {
    if (draft.trim()) onSeg("~" + encodeCustomName(draft));
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={ref}
        value={draft}
        placeholder="语言名,如 泰语"
        className="field !h-[22px] !text-[12px] w-[92px]"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setEditing(false);
        }}
      />
    );
  }
  return (
    <select
      className={SELECT_CLS}
      value={seg}
      onChange={(e) => {
        if (e.target.value === "__custom__") { setDraft(""); setEditing(true); } else onSeg(e.target.value);
      }}
    >
      {!LANGS.some((l) => l.code === seg) && <option value={seg}>{langZh(seg)}</option>}
      {LANGS.map((l) => (
        <option key={l.code} value={l.code}>{l.zh}</option>
      ))}
      <option value="__custom__">其他…</option>
    </select>
  );
}

export function DirPicker({ value, onChange }: { value: string; onChange: (d: string) => void }) {
  const [a, b] = splitDir(value);
  if (value === "auto") {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className="inline-flex items-center gap-1 h-[22px] px-2 rounded-md bg-accentsoft text-accent text-[12px] font-medium whitespace-nowrap">
          <Icon n="zap" size={12} /> 自动识别
        </span>
        <button
          title="放弃自动,手动指定方向"
          className="border-none bg-transparent text-[12px] text-accent px-0.5 whitespace-nowrap"
          onClick={() => onChange("en2zh")}
        >
          改手动
        </button>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <button
        title="自动识别语言:中文→英,其余→中"
        className="tbtn !w-6 !h-6"
        onClick={() => onChange("auto")}
      >
        <Icon n="zap" size={13} />
      </button>
      <SegSelect seg={a} onSeg={(s) => onChange(makeDir(s, b))} />
      <button
        title="交换方向"
        className="tbtn !w-6 !h-6"
        onClick={() => onChange(makeDir(b, a))}
      >
        <Icon n="swap" size={13} />
      </button>
      <SegSelect seg={b} onSeg={(s) => onChange(makeDir(a, s))} />
    </span>
  );
}
