import detailCss from "../product-detail.module.css";

export function ProductDetailSkeleton() {
  return (
    <div className={detailCss.skeletonWrap} aria-busy="true" aria-label="Loading product">
      <div className={`${detailCss.skeletonBlock} ${detailCss.skeletonShell}`}>
        <div className={detailCss.skeletonBody}>
          <div className={detailCss.skeletonMainCol}>
            <div className={detailCss.skeletonHero}>
              <div className={`${detailCss.skeletonBlock} ${detailCss.skeletonImage}`} />
              <div className={detailCss.skeletonHeroText}>
                <div className={`${detailCss.skeletonBlock} ${detailCss.skeletonTitle}`} />
                <div className={`${detailCss.skeletonBlock} ${detailCss.skeletonLine}`} />
                <div className={`${detailCss.skeletonBlock} ${detailCss.skeletonLineShort}`} />
              </div>
            </div>
            <div className={detailCss.skeletonMetrics}>
              <div className={`${detailCss.skeletonBlock} ${detailCss.skeletonMetric}`} />
              <div className={`${detailCss.skeletonBlock} ${detailCss.skeletonMetric}`} />
              <div className={`${detailCss.skeletonBlock} ${detailCss.skeletonMetric}`} />
              <div className={`${detailCss.skeletonBlock} ${detailCss.skeletonMetric}`} />
              <div className={`${detailCss.skeletonBlock} ${detailCss.skeletonMetric}`} />
            </div>
            <div className={`${detailCss.skeletonBlock} ${detailCss.skeletonMain}`} />
          </div>
          <div className={detailCss.skeletonSideCol}>
            <div className={`${detailCss.skeletonBlock} ${detailCss.skeletonSide}`} />
          </div>
        </div>
      </div>
    </div>
  );
}
