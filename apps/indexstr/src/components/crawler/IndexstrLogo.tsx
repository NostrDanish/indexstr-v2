import { cn } from '@/lib/utils';

export interface IndexstrLogoProps extends React.ImgHTMLAttributes<HTMLImageElement> {
  /** Gently pulse the logo while the crawler is active. */
  animated?: boolean;
}

/**
 * The logo lives at /brand/logo.png, but some dev/preview sandboxes can only
 * serve the JS bundle (everything else falls back to index.html). The same
 * image is content-addressed on Blossom, so a broken local file swaps over.
 */
const BLOSSOM_LOGO =
  'https://blossom.primal.net/116496043069037ceceabdd0f4420bfe15e7d50613550e441ba0f53fed2d884f.png';

/**
 * The Indexstr mark — a spider sitting in its web.
 *
 * Note the artwork ships on a black tile by design, so it renders identically
 * in light and dark mode.
 */
export function IndexstrLogo({ animated = false, className, alt = 'Indexstr', ...props }: IndexstrLogoProps) {
  return (
    <img
      src="/brand/logo.png"
      alt={alt}
      draggable={false}
      onError={(event) => {
        const img = event.currentTarget;
        if (img.src !== BLOSSOM_LOGO) img.src = BLOSSOM_LOGO;
      }}
      className={cn(
        'shrink-0 select-none rounded-lg',
        animated && 'motion-safe:animate-pulse',
        className,
      )}
      {...props}
    />
  );
}
