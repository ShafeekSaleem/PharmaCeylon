import detailCss from "../product-detail.module.css";

export function ProductDetailSkeleton() {
  return (
    <div className={detailCss.skeletonWrap} aria-busy="true" aria-label="Loading product">
      <div className={`${detailCss.skeletonBlock} ${detailCss.skeletonBack}`} />
      <div className={detailCss.skeletonHero}>
        <div className={`${detailCss.skeletonBlock} ${detailCss.skeletonImage}`} />
        <div className={detailCss.skeletonHeroText}>
          <div className={`${detailCss.skeletonBlock} ${detailCss.skeletonTitle}`} />
          <div className={`${detailCss.skeletonBlock} ${detailCss.skeletonLine}`} />
          <div className={`${detailCss.skeletonBlock} ${detailCss.skeletonLineShort}`} />
        </div>
      </div>
      <div className={detailCss.skeletonActions}>
        <div className={`${detailCss.skeletonBlock} ${detailCss.skeletonBtn}`} />
        <div className={`${detailCss.skeletonBlock} ${detailCss.skeletonBtn}`} />
        <div className={`${detailCss.skeletonBlock} ${detailCss.skeletonBtn}`} />
      </div>
      <div className={detailCss.skeletonLayout}>
        <div className={`${detailCss.skeletonBlock} ${detailCss.skeletonMain}`} />
        <div className={`${detailCss.skeletonBlock} ${detailCss.skeletonSide}`} />
      </div>
    </div>
  );
}
