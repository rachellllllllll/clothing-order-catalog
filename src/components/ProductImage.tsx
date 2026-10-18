import { useState } from 'react';

interface Props {
  src: string | undefined;
  alt: string;
  placeholder?: string;
  placeholderClassName?: string;
  className?: string;
  lazy?: boolean;
}

export function ProductImage({
  src,
  alt,
  placeholder = 'אין תמונה',
  placeholderClassName = 'img-placeholder',
  className,
  lazy = true,
}: Props) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  if (!src || failedSrc === src) return <div className={placeholderClassName}>{placeholder}</div>;

  return (
    <img
      className={className}
      src={src}
      alt={alt}
      loading={lazy ? 'lazy' : undefined}
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailedSrc(src)}
    />
  );
}
