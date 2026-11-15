// 方向选择器(主窗设置/composer + 快捷窗共用):两个语言下拉 + 交换;下拉含「其他…」自定义
import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import { LANGS, encodeCustomName, langZh, makeDir, splitDir } from "./languages";

const SELECT_CLS =
  "h-7 max-w-[110px] text-xs bg-transparent border border-line rounded-[7px] px-1.5 cursor-pointer outline-none focus:border-accent text-t1";

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
        className="h-7 w-[92px] text-xs bg-surface border border-accent rounded-[7px] px-1.5 outline-none text-t1"
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
  return (
    <span className="inline-flex items-center gap-1.5">
      <SegSelect seg={a} onSeg={(s) => onChange(makeDir(s, b))} />
      <button
        title="交换方向"
        className="flex items-center border-none bg-none text-t2 cursor-pointer p-0.5 hover:text-accent"
        onClick={() => onChange(makeDir(b, a))}
      >
        <Icon n="swap" size={13} />
      </button>
      <SegSelect seg={b} onSeg={(s) => onChange(makeDir(a, s))} />
    </span>
  );
}
