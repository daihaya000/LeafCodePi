// Wire contract for peer auth sharing (docs/plans/peer-auth-share.md).
// The implementation lives in backend/core so both the Web build (mirror layout: backend-core/ and
// shared/ are siblings) and the Backend runtime resolve it; this file is the stable import path.
export * from "../backend/core/peer-auth-wire.mjs";
