// Compatibility entrypoint: the implementation lives in backend core so the
// Backend process can resolve application paths without importing the Web app.
export {
  dataDir,
  displayLeafcodePiDataPath,
  isAbsolutePath,
  noProjectRoot,
  noProjectSessionDir,
  pathKey,
  resolveNoProjectRoot,
  sameOrDescendantPath,
  samePath,
  storePath,
  webUiAuthConfigPath,
} from "@backend-core/app-paths.mjs";
