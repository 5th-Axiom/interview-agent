export class SpokenOutputError extends Error {
  constructor() {
    super("回复不符合语音输出约束");
    this.name = "SpokenOutputError";
  }
}
// A bounded defense in addition to the versioned prompt. It deliberately does not claim semantic completeness.
export function spokenText(text: string) {
  const clean = text.trim();
  if (
    /```|<\/?(?:think|analysis|tool_call)>|^(?:我|接下来|需要|应该).{0,20}(?:调用|使用).{0,12}(?:工具|function)|(?:我需要|接下来需要|应该).{0,18}(?:候选人|工具|确认用户)|(?:request_end_confirmation|complete_interview|select_role)|"(?:tool_calls|arguments)"/i.test(
      clean,
    )
  )
    throw new SpokenOutputError();
  if (clean.length > 160) throw new SpokenOutputError();
  return clean;
}
