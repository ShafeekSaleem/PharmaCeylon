"use client";

import { IconEye, IconGrid, IconSearch } from "@/components/icons";
import css from "../catalog.module.css";
import type { CatalogFacets } from "../types";

type Props = {
  recent: string[];
  facets: CatalogFacets | null;
  onSearch: (q: string) => void;
  onCategory: (categoryId: string) => void;
  recentViews: Array<{ id: string; name: string }>;
  onSelectProduct: (id: string) => void;
};

export function CatalogDiscoveryEmpty({
  recent,
  facets,
  onSearch,
  onCategory,
  recentViews,
  onSelectProduct,
}: Props) {
  const categories = (facets?.categories ?? []).slice(0, 4);
  const recentTerms = recent.slice(0, 4);

  return (
    <div className={css.discovery}>
      <div className={css.discoveryHero}>
        <div className={css.discoveryArt} aria-hidden>
          <svg width="88" height="88" viewBox="0 0 88 88" fill="none">
            <rect
              x="18"
              y="22"
              width="40"
              height="50"
              rx="6"
              stroke="currentColor"
              strokeWidth="2.5"
              opacity="0.35"
            />
            <path
              d="M28 34h20M28 42h16M28 50h12"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              opacity="0.35"
            />
            <circle cx="54" cy="54" r="16" fill="var(--pc-card-bg)" stroke="currentColor" strokeWidth="2.75" />
            <path
              d="M65 65l8 8"
              stroke="currentColor"
              strokeWidth="2.75"
              strokeLinecap="round"
            />
          </svg>
        </div>
        <h2 className={css.discoveryTitle}>Start searching to find products</h2>
        <p className={css.discoveryText}>
          Use the search bar above, pick a quick filter, or jump in from recent activity
          below.
        </p>
      </div>

      <div className={css.discoveryGrid}>
        <section className={css.discoveryCard}>
          <header className={css.discoveryCardHead}>
            <span className={`${css.discoveryCardIcon} ${css.iconClock}`}>
              <IconClock size={16} />
            </span>
            <h3>Recent searches</h3>
          </header>
          {recentTerms.length > 0 ? (
            <ul className={css.discoveryList}>
              {recentTerms.map((term) => (
                <li key={term}>
                  <button type="button" className={css.discoveryLink} onClick={() => onSearch(term)}>
                    <IconSearch size={14} />
                    <span>{term}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className={css.discoveryMuted}>Your recent searches will show up here.</p>
          )}
        </section>

        <section className={css.discoveryCard}>
          <header className={css.discoveryCardHead}>
            <span className={`${css.discoveryCardIcon} ${css.iconGrid}`}>
              <IconGrid size={16} />
            </span>
            <h3>Popular categories</h3>
          </header>
          {categories.length > 0 ? (
            <ul className={css.discoveryList}>
              {categories.map((c) => (
                <li key={c.value}>
                  <button
                    type="button"
                    className={css.discoveryLink}
                    onClick={() => onCategory(c.value)}
                  >
                    <IconGrid size={14} />
                    <span>
                      {c.label}
                      <em> · {c.count}</em>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className={css.discoveryMuted}>Categories will appear once the catalog loads.</p>
          )}
        </section>

        <section className={css.discoveryCard}>
          <header className={css.discoveryCardHead}>
            <span className={`${css.discoveryCardIcon} ${css.iconEye}`}>
              <IconEye size={16} />
            </span>
            <h3>Recently viewed</h3>
          </header>
          {recentViews.length > 0 ? (
            <ul className={css.discoveryList}>
              {recentViews.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    className={css.discoveryLink}
                    onClick={() => onSelectProduct(p.id)}
                  >
                    <IconEye size={14} />
                    <span>{p.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className={css.discoveryMuted}>
              No recently viewed products. Products you open will appear here for quick
              access.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

function IconClock({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.75" />
      <path
        d="M12 8v4.5l3 1.5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
