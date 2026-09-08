"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Check, Pencil, Shuffle, Upload } from "lucide-react";
import { BotAvatar } from "./BotAvatar";
import { Button, cx } from "@/components/ui";
import {
  autoEyeColor, AVATAR_IMAGE_ACCEPT, avatarColorForId, BOT_AVATAR_COLORS, BOT_AVATAR_SHAPES,
  isAvatarColor, isAvatarImage, MAX_AVATAR_IMAGE_BYTES, randomAvatarColor,
} from "@/lib/bot-avatar";
import type { BotDto } from "@/lib/types";

export type AvatarPatch = Partial<Pick<BotDto, "avatarShape" | "avatarColor" | "avatarImage" | "avatarGlasses" | "avatarMustache">> & { avatarEyeColor?: string | null };
const TABS = ["Bot", "生成", "アップロード"] as const;
const EYE_COLORS = ["#FFFFFF", ...BOT_AVATAR_COLORS] as const;

function generateCandidates() {
  const start = Math.floor(Math.random() * BOT_AVATAR_SHAPES.length);
  return Array.from({ length: 6 }, (_, index) => ({
    avatarShape: BOT_AVATAR_SHAPES[(start + index) % BOT_AVATAR_SHAPES.length]!.id,
    avatarColor: randomAvatarColor(),
    avatarGlasses: Math.random() < 0.35,
    avatarMustache: Math.random() < 0.35,
    avatarImage: null,
  }));
}

/** Swatch palette plus a free color, shared by the body color and the eye color. */
function ColorField({ label, value, colors, disabled, onSelect }: { label: string; value: string; colors: readonly string[]; disabled: boolean; onSelect: (color: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const valid = isAvatarColor(draft);
  return (
    <section>
      <p className="mb-2 text-xs font-medium text-muted">{label}</p>
      <div role="group" aria-label={label} className="grid grid-cols-[repeat(auto-fit,minmax(2.75rem,1fr))] gap-1">
        {colors.map((color) => <button key={color} type="button" aria-label={`${label} ${color}`} aria-pressed={value.toUpperCase() === color} disabled={disabled} onClick={() => onSelect(color)} className="flex h-11 min-w-11 items-center justify-center rounded-full hover:bg-surface-2 disabled:opacity-50"><span className={cx("h-8 w-8 rounded-full border border-border", value.toUpperCase() === color && "ring-2 ring-accent ring-offset-2 ring-offset-surface")} style={{ backgroundColor: color }} /></button>)}
      </div>
      <form className="mt-2 flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); if (valid) onSelect(draft.toUpperCase()); }}>
        <input type="color" aria-label={`${label}のカラーピッカー`} value={valid ? draft : value} disabled={disabled} onChange={(event) => setDraft(event.target.value)} className="h-11 w-11 shrink-0 cursor-pointer rounded-lg border border-border bg-surface p-1 disabled:opacity-50" />
        <input type="text" aria-label={`${label}のカラーコード`} value={draft} maxLength={7} spellCheck={false} aria-invalid={!valid} disabled={disabled} onChange={(event) => setDraft(event.target.value)} className="h-11 min-w-0 flex-1 rounded-lg border border-border bg-surface px-2 font-mono text-sm" />
        <Button type="submit" variant="ghost" disabled={disabled || !valid} className="min-h-11 px-3">適用</Button>
      </form>
      {!valid && <p className="mt-1 text-xs text-danger">#と6桁の英数字（0–9・A–F）を入力してください。</p>}
    </section>
  );
}

export function BotAvatarPicker({ bot, onChange }: { bot: BotDto; onChange: (patch: AvatarPatch) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [candidates, setCandidates] = useState<ReturnType<typeof generateCandidates>>([]);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const locked = useRef(false);
  const uid = useId();
  const shape = bot.avatarShape ?? "circle";

  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus();
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);

  async function update(patch: AvatarPatch, file?: File) {
    if (locked.current) return;
    setError(null);
    setSaved(false);
    if (file && (!/^image\/(png|jpeg|gif|webp)$/.test(file.type) || file.size > MAX_AVATAR_IMAGE_BYTES)) {
      setError("PNG・JPEG・GIF・WebPの2 MB以下の画像を選択してください。");
      return;
    }
    locked.current = true;
    setBusy(true);
    try {
      if (file) {
        const image = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = reader.onabort = () => reject(new Error("画像を読み込めませんでした。もう一度選択してください。"));
          reader.readAsDataURL(file);
        });
        if (!isAvatarImage(image)) throw new Error("この画像は使用できません。");
        patch = { avatarImage: image };
      }
      await onChange(patch);
      setSaved(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "アイコンを保存できませんでした。もう一度お試しください。");
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }

  const applied = (candidate: ReturnType<typeof generateCandidates>[number]) => !bot.avatarImage
    && shape === candidate.avatarShape && bot.avatarColor === candidate.avatarColor
    && (bot.avatarGlasses ?? false) === candidate.avatarGlasses && (bot.avatarMustache ?? false) === candidate.avatarMustache;

  function selectTab(index: number) {
    setTab(index);
    if (index === 1 && candidates.length === 0) setCandidates(generateCandidates());
  }

  return (
    <div ref={root} className="relative mx-auto w-full max-w-md pb-4 pt-4" onBlurCapture={(event) => {
      if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }} onKeyDown={(event) => {
      if (open && event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }
    }}>
      <div className="flex flex-col items-center gap-2">
        <button ref={trigger} type="button" aria-label="ボットのアイコンを変更" aria-haspopup="dialog" aria-expanded={open} aria-controls={`${uid}-picker`}
          onClick={() => setOpen((value) => !value)}
          className="group relative rounded-full p-1 ring-2 ring-border-strong transition-colors hover:ring-accent focus-visible:outline-none focus-visible:ring-accent">
          <BotAvatar size={80} {...bot} />
          <span aria-hidden="true" className="absolute bottom-0 right-0 flex h-7 w-7 items-center justify-center rounded-full border border-border bg-surface text-muted group-hover:text-accent"><Pencil className="h-4 w-4" /></span>
        </button>
        <p className="text-xs text-muted">クリックしてアイコンを変更</p>
      </div>
      {open && <div id={`${uid}-picker`} role="dialog" aria-label="ボットのアイコン" className="absolute inset-x-0 top-full z-30 flex max-h-[55dvh] flex-col overflow-hidden rounded-[20px] border border-border bg-surface/95 text-text shadow-[0_8px_30px_rgba(0,0,0,0.12)] backdrop-blur-xl">
        <div className="flex shrink-0 flex-wrap items-center border-b border-border p-2">
          <div role="tablist" aria-label="アイコンの種類" className="flex" onKeyDown={(event) => {
            const next = event.key === "ArrowRight" ? (tab + 1) % TABS.length : event.key === "ArrowLeft" ? (tab + TABS.length - 1) % TABS.length : event.key === "Home" ? 0 : event.key === "End" ? TABS.length - 1 : null;
            if (next === null) return;
            event.preventDefault();
            selectTab(next);
            document.getElementById(`${uid}-tab-${next}`)?.focus();
          }}>
            {TABS.map((label, index) => <button key={label} type="button" role="tab" id={`${uid}-tab-${index}`} aria-selected={tab === index} aria-controls={`${uid}-panel-${index}`} tabIndex={tab === index ? 0 : -1} onClick={() => selectTab(index)} className={cx("min-h-11 rounded-lg px-2 text-sm", tab === index ? "bg-surface-2 font-medium" : "text-muted hover:bg-surface-2")}>{label}</button>)}
          </div>
          <button type="button" disabled={busy} title="標準の形・色・装飾に戻し、画像を削除" onClick={() => void update({ avatarShape: "circle", avatarColor: avatarColorForId(bot.id), avatarEyeColor: null, avatarGlasses: false, avatarMustache: false, avatarImage: null })} className="ml-auto min-h-11 rounded-lg px-2 text-xs text-muted hover:bg-surface-2 hover:text-text disabled:opacity-50">リセット</button>
        </div>
        <div className="min-h-0 overflow-y-auto overscroll-contain p-4">
          <div role="tabpanel" id={`${uid}-panel-${tab}`} aria-labelledby={`${uid}-tab-${tab}`} tabIndex={0}>
            {tab === 0 && <div className="space-y-4">
              <div role="group" aria-label="ボットの形" className="grid grid-cols-4 gap-2">
                {BOT_AVATAR_SHAPES.map((face) => <button key={face.id} type="button" aria-label={face.label} title={face.label} aria-pressed={!bot.avatarImage && shape === face.id} disabled={busy} onClick={() => void update({ avatarShape: face.id, avatarImage: null })} className={cx("flex min-h-14 min-w-0 items-center justify-center rounded-xl p-2 hover:bg-surface-2 disabled:opacity-50", !bot.avatarImage && shape === face.id && "bg-surface-2 ring-2 ring-inset ring-accent")}><BotAvatar size={44} {...bot} avatarImage={null} avatarShape={face.id} /></button>)}
              </div>
              <div role="group" aria-label="装飾" className="flex gap-2">
                <button type="button" aria-pressed={bot.avatarGlasses === true} disabled={busy} onClick={() => void update({ avatarGlasses: bot.avatarGlasses !== true, avatarImage: null })} className={cx("min-h-11 flex-1 rounded-xl border px-3 text-sm", bot.avatarGlasses ? "border-accent bg-accent/10 font-medium text-accent" : "border-border text-muted hover:bg-surface-2")}>眼鏡</button>
                <button type="button" aria-pressed={bot.avatarMustache === true} disabled={busy} onClick={() => void update({ avatarMustache: bot.avatarMustache !== true, avatarImage: null })} className={cx("min-h-11 flex-1 rounded-xl border px-3 text-sm", bot.avatarMustache ? "border-accent bg-accent/10 font-medium text-accent" : "border-border text-muted hover:bg-surface-2")}>口ひげ</button>
              </div>
              <ColorField label="本体の色" value={bot.avatarColor} colors={BOT_AVATAR_COLORS} disabled={busy} onSelect={(color) => void update({ avatarColor: color, avatarImage: null })} />
              <ColorField label="目の色" value={bot.avatarEyeColor ?? autoEyeColor(bot.avatarColor)} colors={EYE_COLORS} disabled={busy} onSelect={(color) => void update({ avatarEyeColor: color, avatarImage: null })} />
            </div>}
            {tab === 1 && <div className="space-y-4">
              <p className="text-xs leading-5 text-muted">形と色をランダムに組み合わせます。好きな候補を選ぶと保存されます。</p>
              <div role="group" aria-label="生成したアイコン" className="grid grid-cols-3 gap-2">
                {candidates.map((candidate, index) => <button key={index} type="button" aria-label={`候補 ${index + 1}`} aria-pressed={applied(candidate)} disabled={busy} onClick={() => void update(candidate)} className={cx("flex min-h-20 items-center justify-center rounded-xl p-2 hover:bg-surface-2 disabled:opacity-50", applied(candidate) && "ring-2 ring-inset ring-accent")}><BotAvatar size={56} {...bot} {...candidate} /></button>)}
              </div>
              <Button variant="ghost" disabled={busy} onClick={() => setCandidates(generateCandidates())} className="min-h-11 w-full"><Shuffle className="h-4 w-4" />別の候補を生成</Button>
            </div>}
            {tab === 2 && <div className="flex flex-col items-center gap-4 py-2">
              <BotAvatar size={76} {...bot} />
              <label className={cx("flex min-h-11 cursor-pointer items-center gap-2 rounded-xl bg-surface-2 px-4 py-2 text-sm text-accent has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent", busy && "pointer-events-none opacity-50")}><Upload className="h-4 w-4" />画像を選択<input type="file" aria-label="ボットの画像を設定" accept={AVATAR_IMAGE_ACCEPT} disabled={busy} className="sr-only" onChange={(event) => { const file = event.target.files?.[0]; if (file) void update({}, file); event.currentTarget.value = ""; }} /></label>
              <p className="text-center text-xs leading-5 text-muted">PNG・JPEG・GIF・WebP / 最大2 MB<br />画像は丸く切り抜いて表示します。</p>
              {bot.avatarImage && <Button variant="ghost" disabled={busy} onClick={() => void update({ avatarImage: null })} className="min-h-11 text-danger">画像を削除</Button>}
            </div>}
          </div>
          <p role="status" aria-live="polite" className="mt-4 flex min-h-4 items-center justify-center gap-1 text-xs text-muted">{busy ? "保存中…" : saved ? <><Check className="h-3 w-3" />保存しました</> : "変更は自動保存されます"}</p>
          {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
        </div>
      </div>}
      {!open && error && <p role="alert" className="mt-2 text-center text-xs text-danger">{error}</p>}
    </div>
  );
}
