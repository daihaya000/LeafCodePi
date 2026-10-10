/** Compile-time substitutions only. No Node globals or runtime process polyfill. */
export {};
declare global {
  const process: {
    readonly env: {
      readonly NODE_ENV: "development" | "production" | "test";
      readonly NEXT_PUBLIC_LEAFCODE_PI_BUILD_COMMIT?: string;
      readonly NEXT_PUBLIC_LEAFCODE_PI_BUILD_COMMIT_DATE?: string;
    };
  };
}
