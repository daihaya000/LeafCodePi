import { lazy, Suspense, type AnchorHTMLAttributes, type ComponentType, type ImgHTMLAttributes, type ReactNode } from "react";
import { useRouter } from "./navigation";

export function Link({ href, children, prefetch: _prefetch, replace, scroll, onClick, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; prefetch?: boolean; replace?: boolean; scroll?: boolean; children?: ReactNode }) {
  const router = useRouter();
  return <a {...props} href={href} onClick={event => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.altKey || event.ctrlKey || event.shiftKey || props.download !== undefined || props.target && props.target !== "_self") return;
    const url = new URL(href, window.location.href);
    if (url.origin !== window.location.origin || !["http:", "https:"].includes(url.protocol)) return;
    event.preventDefault(); router[replace ? "replace" : "push"](href, { scroll });
  }}>{children}</a>;
}
export function Image({ fill, priority, unoptimized: _unoptimized, style, ...props }: ImgHTMLAttributes<HTMLImageElement> & { fill?: boolean; priority?: boolean; unoptimized?: boolean }) {
  return <img {...props} loading={priority ? "eager" : props.loading ?? "lazy"} style={fill ? { position: "absolute", height: "100%", width: "100%", inset: 0, ...style } : style} />;
}
export function dynamic<P extends object>(loader: () => Promise<ComponentType<P> | { default: ComponentType<P> }>, options?: { loading?: ComponentType; ssr?: boolean }) {
  const Component = lazy(async () => { const module = await loader(); return { default: typeof module === "object" && "default" in module ? module.default : module as ComponentType<P> }; });
  return function LazyComponent(props: P) { const Loading = options?.loading; return <Suspense fallback={Loading ? <Loading /> : null}><Component {...props} /></Suspense>; };
}
