'use client';

import Link from 'next/link';
import { Icon, StatusDot } from './ui.js';

// One product as an image-forward card: a collage of its latest images (or its
// reference photo until there are any) and one status dot per image slot.
export default function ProductCard({ p, showBrand }) {
  const n = p.thumbs.length;
  const attention = p.slots.filter((s) => s.status === 'review' || s.status === 'error' || s.status === 'choose').length;
  return (
    <Link href={`/products/${p.id}`} className="pcard">
      <div className="pcard-media">
        {n > 0 ? (
          <div className={`collage c${n}`}>
            {p.thumbs.map((t) => (
              <img key={t} src={`/api/files/${t}`} alt="" loading="lazy" />
            ))}
          </div>
        ) : p.photo ? (
          <img className="photo" src={`/api/files/${p.photo}`} alt="" loading="lazy" />
        ) : (
          <Icon name="image" size={34} />
        )}
      </div>
      <div className="pcard-body">
        <div className="pcard-title">{p.name}</div>
        <div className="pcard-sub">
          {showBrand ? `${p.brand}: ` : ''}
          {p.approved} of {p.total} approved
        </div>
        <div className="pcard-foot">
          <div className="dots">
            {p.slots.map((s) => (
              <StatusDot key={s.id} status={s.status} />
            ))}
          </div>
          {p.auto_status === 'running' ? (
            <span className="badge busy">Auto running</span>
          ) : attention > 0 ? (
            <span className="badge warn">{attention} to review</span>
          ) : null}
        </div>
      </div>
    </Link>
  );
}
