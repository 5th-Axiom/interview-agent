"use client";
import { useLayoutEffect, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import { Button } from "@/components/base/ui";
import type { LiveCaption } from "@/features/interview/live-captions";

export function LiveCaptions({
  entries,
  active,
}: {
  entries: LiveCaption[];
  active: boolean;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const userScrollUntil = useRef(0);
  const [atLatest, setAtLatest] = useState(true);
  function beginUserScroll() {
    userScrollUntil.current = performance.now() + 1500;
  }
  function follow() {
    const el = viewport.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  }
  useLayoutEffect(follow, [entries]);
  useLayoutEffect(() => {
    const observer = new ResizeObserver(follow);
    observer.observe(viewport.current!);
    observer.observe(content.current!);
    return () => observer.disconnect();
  }, []);
  return (
    <section className="live-captions" aria-label="实时字幕">
      <div className="live-captions-heading">
        <strong>实时字幕</strong>
        {!atLatest && (
          <Button
            variant="quiet"
            onClick={() => {
              following.current = true;
              userScrollUntil.current = 0;
              setAtLatest(true);
              follow();
              viewport.current?.focus({ preventScroll: true });
            }}
          >
            <ArrowDown />
            回到最新
          </Button>
        )}
      </div>
      <div
        ref={viewport}
        className="live-captions-scroll"
        role="region"
        aria-label="双方实时字幕，可上下滚动"
        tabIndex={0}
        onWheel={beginUserScroll}
        onTouchStart={beginUserScroll}
        onTouchMove={beginUserScroll}
        onPointerDown={beginUserScroll}
        onKeyDown={(event) => {
          if (
            [
              "ArrowUp",
              "ArrowDown",
              "PageUp",
              "PageDown",
              "Home",
              "End",
              " ",
            ].includes(event.key)
          )
            beginUserScroll();
        }}
        onScroll={() => {
          // Layout changes and follow() also fire scroll. Only a user gesture
          // can turn off following; keep touch/wheel momentum in that gesture.
          if (performance.now() > userScrollUntil.current) return;
          beginUserScroll();
          const el = viewport.current!;
          const bottom = el.scrollHeight - el.clientHeight - el.scrollTop < 32;
          following.current = bottom;
          setAtLatest(bottom);
        }}
      >
        <div ref={content}>
          {entries.map((entry) => (
            <article
              className="live-caption"
              key={entry.id}
              data-speaker={entry.speaker}
            >
              <div className="live-caption-label">
                <strong>{entry.speaker === "user" ? "我" : "AI 面试官"}</strong>
                {entry.status !== "complete" && (
                  <span>
                    {entry.status === "transcribing"
                      ? "正在转写"
                      : entry.status === "interrupted"
                        ? "已打断"
                        : "转写待确认"}
                  </span>
                )}
              </div>
              <p>{entry.text}</p>
            </article>
          ))}
          {!entries.length && (
            <p className="live-captions-empty">
              {active
                ? "开始说话后，这里会显示你和 AI 的对话。"
                : "开始或继续交流后，这里会显示双方字幕。"}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
