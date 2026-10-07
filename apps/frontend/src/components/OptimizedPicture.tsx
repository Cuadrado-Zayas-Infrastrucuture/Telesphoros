interface PictureData {
  sources: Record<string, string>;
  img: { src: string; w: number; h: number };
}

interface OptimizedPictureProps {
  picture: PictureData;
  /** Meaningful description; never leave empty for informative images. */
  alt: string;
  sizes: string;
  className?: string;
}

/**
 * Serves AVIF/WebP with a PNG fallback (generated at build time by vite-imagetools).
 * Intended for below-the-fold images: width/height prevent layout shift, loading="lazy" defers the fetch.
 */
export function OptimizedPicture({ picture, alt, sizes, className }: OptimizedPictureProps) {
  return (
    <picture>
      {Object.entries(picture.sources).map(([format, srcSet]) => (
        <source key={format} type={`image/${format}`} srcSet={srcSet} sizes={sizes} />
      ))}
      <img
        src={picture.img.src}
        width={picture.img.w}
        height={picture.img.h}
        alt={alt}
        sizes={sizes}
        loading="lazy"
        decoding="async"
        className={className}
      />
    </picture>
  );
}
