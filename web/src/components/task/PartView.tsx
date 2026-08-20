"use client";

import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronRight } from "lucide-react";
import { ProviderIcon } from "@/components/ProviderIcon";
import { cx, formatMessageTime } from "@/components/ui";
import type { UiMessage, UiPart } from "@/lib/types";

function MarkdownBody({ text }: { text: string }) {
  return (
    <div className="md text-sm">
      <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
    </div>
  );
}

function ToolCard({ part }: { part: Extract<UiPart, { type: "tool" }> }) {
  const [open, setOpen] = useState(part.state.status !== "completed");
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface-2">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs"
      >
        <ChevronRight className={cx("h-3.5 w-3.5 text-muted transition", open && "rotate-90")} />
        <span className="font-mono font-medium">{part.tool}</span>
        <span
          className={cx(
            "ml-auto rounded-full px-2 py-0.5 text-[10px]",
            part.state.status === "running" && "bg-working-bg text-working",
            part.state.status === "completed" && "bg-success-bg text-success",
            part.state.status === "error" && "bg-danger-bg text-danger",
          )}
        >
          {part.state.status}
        </span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-border px-3 py-2 font-mono text-[11px] text-muted">
          {part.state.input && (
            <pre className="overflow-x-auto whitespace-pre-wrap">{JSON.stringify(part.state.input, null, 2)}</pre>
          )}
          {part.state.output && <pre className="overflow-x-auto whitespace-pre-wrap text-text">{part.state.output}</pre>}
          {part.state.error && <pre className="overflow-x-auto whitespace-pre-wrap text-danger">{part.state.error}</pre>}
        </div>
      )}
    </div>
  );
}

export function PartView({ message }: { message: UiMessage }) {
  const isUser = message.role === "user";
  return (
    <article className={cx("flex flex-col gap-2", isUser ? "items-end" : "items-start")}>
      <div className="flex items-center gap-2 text-[11px] text-muted">
        {isUser ? (
          <span className="font-medium text-text">あなた</span>
        ) : (
          <>
            <ProviderIcon providerID={message.provider} size={14} />
            <span className="font-medium text-text">Pi</span>
          </>
        )}
        {message.provider && message.model && (
          <span className="font-mono">
            {message.provider}/{message.model}
          </span>
        )}
        <span>{formatMessageTime(message.createdAt)}</span>
      </div>
      <div className={cx("w-full max-w-3xl space-y-2", isUser && "rounded-2xl border border-border bg-surface px-4 py-3")}>
        {message.parts.map((part) => {
          if (part.type === "text") {
            return isUser ? (
              <p key={part.id} className="whitespace-pre-wrap text-sm">
                {part.text}
              </p>
            ) : (
              <MarkdownBody key={part.id} text={part.text} />
            );
          }
          if (part.type === "thinking") {
            return (
              <details key={part.id} className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs text-muted">
                <summary className="cursor-pointer">思考</summary>
                <pre className="mt-2 whitespace-pre-wrap font-sans">{part.text}</pre>
              </details>
            );
          }
          if (part.type === "image") {
            return (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={part.id} src={part.url} alt={part.filename ?? "画像"} className="max-h-64 rounded-lg border border-border" />
            );
          }
          return <ToolCard key={part.id} part={part} />;
        })}
        {message.error && (
          <p className="rounded-lg border border-danger/30 bg-danger-bg px-3 py-2 text-sm text-danger">{message.error}</p>
        )}
      </div>
    </article>
  );
}
