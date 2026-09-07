const PPT_NOUN_SOURCE = String.raw`(?:pptx?|power\s*point|\u5e7b\u706f\u7247|\u6f14\u793a\u6587\u7a3f|\u8bfe\u4ef6|slide\s*deck|slides?|deck|presentation)`;

const PPT_REFERENCE_RE = new RegExp(PPT_NOUN_SOURCE, 'i');
const PPT_ATTACHMENT_RE = /\.pptx?$/i;
const PPT_TEXT_ONLY_RE = /(text\s*only|plain\s*text|outline\s*only|markdown\s*only|\u53ea(?:\u8981|\u9700|\u9700\u8981)?(?:\u6587\u5b57|\u6587\u672c|\u5927\u7eb2|\u7ed3\u6784|\u5efa\u8bae|\u601d\u8def)|\u4ec5(?:\u8981|\u9700|\u9700\u8981)?(?:\u6587\u5b57|\u6587\u672c|\u5927\u7eb2|\u7ed3\u6784|\u5efa\u8bae|\u601d\u8def)|(?:\u4e0d\u8981|\u4e0d\u7528|\u65e0\u9700|\u5148\u522b|\u522b).{0,16}(?:\u751f\u6210|\u5236\u4f5c|\u521b\u5efa|\u7ed8\u5236|\u753b|\u8bbe\u8ba1|\u5bfc\u51fa|\u8f93\u51fa|\u4e0b\u8f7d).{0,10}(?:pptx?|power\s*point|\u5e7b\u706f\u7247|\u6f14\u793a\u6587\u7a3f|\u8bfe\u4ef6|slides?|deck|presentation))/i;
const PPT_ANALYSIS_RE = new RegExp(
  String.raw`(?:\u8bfb|\u9605\u8bfb|\u770b|\u770b\u770b|\u89e3\u6790|\u5206\u6790|\u603b\u7ed3|\u6982\u62ec|\u5ba1\u9605|\u68c0\u67e5|\u8bc4\u4ef7|\u8bc4\u4f30|\u63d0\u53d6|\u68b3\u7406|\u89e3\u91ca|\u5bf9\u6bd4|review|read|parse|analy[sz]e|summari[sz]e|inspect|extract|explain).{0,36}${PPT_NOUN_SOURCE}|${PPT_NOUN_SOURCE}.{0,36}(?:\u8bfb|\u9605\u8bfb|\u770b|\u770b\u770b|\u89e3\u6790|\u5206\u6790|\u603b\u7ed3|\u6982\u62ec|\u5ba1\u9605|\u68c0\u67e5|\u8bc4\u4ef7|\u8bc4\u4f30|\u63d0\u53d6|\u68b3\u7406|\u89e3\u91ca|\u5bf9\u6bd4|review|read|parse|analy[sz]e|summari[sz]e|inspect|extract|explain)`,
  'i',
);

const PPT_CREATE_BEFORE_TARGET_RE = new RegExp(
  String.raw`(?:\u751f\u6210(?!\u5f0f)|\u5236\u4f5c|\u521b\u5efa|\u65b0\u5efa|\u505a(?:\u6210)?|\u7ed8\u5236|\u753b|\u8bbe\u8ba1|\u5bfc\u51fa|\u4ea7\u51fa|\u8f93\u51fa|\u6574\u7406\u6210|\u6539\u6210|\u8f6c\u6210|\u91cd\u505a|\u91cd\u5236|\u91cd\u5efa|\u91cd\u65b0\u8bbe\u8ba1|\u7f8e\u5316|\u6539\u7248|create|generate|make|build|export|render|redesign|draw|design).{0,40}${PPT_NOUN_SOURCE}`,
  'i',
);
const PPT_DIRECT_CREATE_RE = new RegExp(
  String.raw`${PPT_NOUN_SOURCE}\s*(?:\u751f\u6210|\u5236\u4f5c|\u521b\u5efa|\u7ed8\u5236|\u753b|\u8bbe\u8ba1|\u5bfc\u51fa|\u91cd\u505a|\u91cd\u5236|\u91cd\u5efa|\u7f8e\u5316|\u6539\u7248|create|generator|maker|export|draw|design)|${PPT_NOUN_SOURCE}.{0,6}(?:\u600e\u4e48|\u5982\u4f55)(?:\u751f\u6210|\u5236\u4f5c|\u521b\u5efa|\u7ed8\u5236|\u8bbe\u8ba1|\u5bfc\u51fa)`,
  'i',
);
const PPT_EDIT_TARGET_RE = new RegExp(
  String.raw`(?:\u7f16\u8f91|\u4fee\u6539|\u91cd\u6392|\u91cd\u6784|\u6da6\u8272|edit|revise|rework).{0,24}${PPT_NOUN_SOURCE}|(?:\u628a|\u5c06).{0,18}${PPT_NOUN_SOURCE}.{0,18}(?:\u7f16\u8f91|\u4fee\u6539|\u91cd\u6392|\u91cd\u6784|\u6da6\u8272|\u91cd\u505a|\u7f8e\u5316|\u6539\u7248|edit|revise|rework)`,
  'i',
);
const EXPLICIT_MODE_CREATE_RE = /(?:\u751f\u6210(?!\u5f0f)|\u5236\u4f5c|\u521b\u5efa|\u65b0\u5efa|\u505a|\u7ed8\u5236|\u753b|\u8bbe\u8ba1|\u5bfc\u51fa|\u4ea7\u51fa|\u91cd\u505a|\u91cd\u5236|\u91cd\u5efa|\u91cd\u65b0\u8bbe\u8ba1|\u7f8e\u5316|\u6539\u7248|create|generate|make|build|export|render|redesign|draw|design)/i;
const TEXTUAL_OUTPUT_TARGET_RE = /(?:\u751f\u6210|\u5236\u4f5c|\u521b\u5efa|\u505a|\u8f93\u51fa|\u5bfc\u51fa|create|generate|make|export).{0,12}(?:\u6587\u5b57|\u6587\u672c|\u6458\u8981|\u603b\u7ed3|\u5206\u6790|\u5efa\u8bae|\u6e05\u5355|\u62a5\u544a|\u8bc4\u8bba|\u8bf4\u660e|text|summary|analysis|suggestions?|report|review)/i;

export function classifyPptIntent(message = '', { attachments = [], explicitPptMode = false } = {}) {
  const text = userFacingMessage(message);
  const mentionsPpt = PPT_REFERENCE_RE.test(text);
  const hasPptAttachment = (Array.isArray(attachments) ? attachments : []).some((item) => {
    const name = String(item?.name || item?.filename || item?.path || '').trim();
    return PPT_ATTACHMENT_RE.test(name);
  });
  const textOnly = PPT_TEXT_ONLY_RE.test(text);
  const analysis = PPT_ANALYSIS_RE.test(text) || (
    hasPptAttachment
    && /(?:\u8bfb|\u9605\u8bfb|\u770b|\u89e3\u6790|\u5206\u6790|\u603b\u7ed3|\u6982\u62ec|\u5ba1\u9605|\u68c0\u67e5|\u8bc4\u4ef7|\u8bc4\u4f30|\u63d0\u53d6|\u68b3\u7406|\u89e3\u91ca|\u5bf9\u6bd4|review|read|parse|analy[sz]e|summari[sz]e|inspect|extract|explain)/i.test(text)
  );
  const explicitArtifact = !textOnly && (
    PPT_CREATE_BEFORE_TARGET_RE.test(text)
    || PPT_DIRECT_CREATE_RE.test(text)
    || PPT_EDIT_TARGET_RE.test(text)
  );
  const explicitModeArtifact = !textOnly
    && explicitPptMode
    && EXPLICIT_MODE_CREATE_RE.test(text)
    && !TEXTUAL_OUTPUT_TARGET_RE.test(text);
  const creation = explicitArtifact || explicitModeArtifact;
  return {
    mentionsPpt,
    hasPptAttachment,
    textOnly,
    analysis,
    creation,
    analysisOnly: analysis && !creation,
  };
}

function userFacingMessage(value = '') {
  const text = String(value || '');
  const resourceMarker = text.indexOf('\n\n\u9644\u52a0\u8d44\u6e90:\n');
  const legacyMarker = text.search(/__JANUS_ATTACHMENT_RESOURCES__/i);
  const indices = [resourceMarker, legacyMarker].filter((index) => index >= 0);
  return (indices.length ? text.slice(0, Math.min(...indices)) : text).trim();
}
