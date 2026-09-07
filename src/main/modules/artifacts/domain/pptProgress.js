export function normalizePptProgress(progress = {}) {
  const source = typeof progress === 'string' ? { message: progress } : (progress || {});
  const normalized = {
    phase: String(source.phase || 'render'),
    currentSlide: Math.max(0, Number(source.current_slide ?? source.currentSlide ?? 0) || 0),
    totalSlides: Math.max(0, Number(source.total_slides ?? source.totalSlides ?? 0) || 0),
    phaseCurrent: Math.max(0, Number(source.phase_current ?? source.phaseCurrent ?? 0) || 0),
    phaseTotal: Math.max(0, Number(source.phase_total ?? source.phaseTotal ?? 0) || 0),
    slideTitle: String(source.slide_title ?? source.slideTitle ?? ''),
    attempt: Math.max(1, Number(source.attempt || 1) || 1),
    elapsedMinutes: Math.max(0, Number(source.elapsed_minutes ?? source.elapsedMinutes ?? 0) || 0),
    status: String(source.status || ''),
    cacheHit: Boolean(source.cache_hit ?? source.cacheHit ?? false),
    cacheHits: Math.max(0, Number(source.cache_hits ?? source.cacheHits ?? 0) || 0),
    concurrency: Math.max(1, Number(source.concurrency || 1) || 1),
    message: String(source.message || '正在制作 PPT'),
  };
  return {
    ...normalized,
    overallPercent: pptOverallPercent(normalized),
  };
}

export function pptOverallPercent(progress = {}) {
  const phase = String(progress.phase || 'render');
  const phaseTotal = Math.max(0, Number(progress.phaseTotal || 0));
  const fallbackTotal = Math.max(0, Number(progress.totalSlides || 0));
  const denominator = phaseTotal || fallbackTotal || 1;
  const numerator = phaseTotal
    ? Math.max(0, Number(progress.phaseCurrent || 0))
    : Math.max(0, Number(progress.currentSlide || 0));
  const fraction = Math.max(0, Math.min(1, numerator / denominator));
  if (phase === 'parse') return Math.round(8 * fraction);
  if (phase === 'image') return Math.round(8 + 20 * fraction);
  if (phase === 'render') return Math.round(28 + 44 * fraction);
  if (phase === 'qa') return Math.round(72 + 10 * fraction);
  if (phase === 'repair') {
    const attemptIndex = Math.max(0, Math.min(1, Number(progress.attempt || 2) - 2));
    return Math.round(82 + attemptIndex * 5 + 5 * fraction);
  }
  if (phase === 'preview') return Math.round(92 + 8 * fraction);
  return 0;
}
