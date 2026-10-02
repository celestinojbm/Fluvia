import Link from 'next/link';
import { categoryLabel, CHANNEL_LABEL } from './categories';
import type { DirectoryEntry } from './public-api';

/** Tarjeta vertical 4:5 con la foto dominante y el texto sobre una franja. */
export function PhotoCard({
  href,
  photo,
  alt,
  chip,
  title,
  text,
}: {
  href: string;
  photo: string;
  alt: string;
  chip?: string;
  title: string;
  text?: string;
}) {
  return (
    <Link className="pb-card" href={href}>
      <img src={photo} alt={alt} loading="lazy" decoding="async" width={640} height={800} />
      <span className="pb-card-body">
        {chip ? <span className="fl-chip-lime">{chip}</span> : null}
        <span className="pb-card-title">{title}</span>
        {text ? <span className="pb-card-text">{text}</span> : null}
      </span>
    </Link>
  );
}

/** Ficha del directorio: un comercio PUBLICADO (los sintéticos dicen «Demo»). */
export function MerchantCard({ entry }: { entry: DirectoryEntry }) {
  const place = [entry.area, entry.city].filter(Boolean).join(' · ');
  return (
    <Link className="pb-card pb-card-merchant" href={`/donde-comprar/${entry.slug}`}>
      {entry.photo_ref ? (
        <img
          src={`/${entry.photo_ref}`}
          alt=""
          loading="lazy"
          decoding="async"
          width={640}
          height={800}
        />
      ) : (
        <span className="pb-card-initial" aria-hidden="true">
          {entry.display_name.slice(0, 1).toUpperCase()}
        </span>
      )}
      <span className="pb-card-body">
        <span className="pb-card-chips">
          <span className="fl-chip-lime">{categoryLabel(entry.category)}</span>
          {entry.is_demo ? <span className="pb-chip-demo">Demo</span> : null}
        </span>
        <span className="pb-card-title">{entry.display_name}</span>
        <span className="pb-card-text">
          {place}
          {entry.channels.length
            ? ` · ${entry.channels.map((c) => CHANNEL_LABEL[c] ?? c).join(' y ')}`
            : ''}
        </span>
      </span>
    </Link>
  );
}
