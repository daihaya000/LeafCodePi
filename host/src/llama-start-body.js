import { isSafeLlamaModelFile, isSafeLlamaPathValue, LLAMA_CACHE_TYPES, LLAMA_SERVER_EFFORTS, LLAMA_SERVER_HOSTS, LLAMA_SERVER_SPEC_TYPES, resolveLlamaServerBin } from "../../shared/llama-server-settings.mjs";
export function parseStartBody(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return null;
    const raw = value;
    const config = {};
    if (raw.effort !== undefined) {
        if (typeof raw.effort !== "string" || !LLAMA_SERVER_EFFORTS.includes(raw.effort)) {
            return null;
        }
        config.effort = raw.effort;
    }
    if (raw.contextLength !== undefined) {
        if (typeof raw.contextLength !== "number" ||
            !Number.isSafeInteger(raw.contextLength) ||
            raw.contextLength < 4096 ||
            raw.contextLength > 1_000_000) {
            return null;
        }
        config.contextLength = raw.contextLength;
    }
    if (raw.parallel !== undefined) {
        if (typeof raw.parallel !== "number" ||
            !Number.isSafeInteger(raw.parallel) ||
            raw.parallel < 1 ||
            raw.parallel > 16) {
            return null;
        }
        config.parallel = raw.parallel;
    }
    if (raw.llamaCppPath !== undefined) {
        if (!isSafeLlamaPathValue(raw.llamaCppPath, process.platform))
            return null;
        const bin = resolveLlamaServerBin(raw.llamaCppPath, process.platform);
        if (bin)
            config.llamaServerBin = bin;
    }
    if (raw.modelDir !== undefined) {
        if (!isSafeLlamaPathValue(raw.modelDir, process.platform))
            return null;
        const modelDir = raw.modelDir.trim();
        if (modelDir)
            config.modelDir = modelDir;
    }
    if (raw.modelFile !== undefined) {
        if (!isSafeLlamaModelFile(raw.modelFile, process.platform))
            return null;
        const modelFile = raw.modelFile.trim();
        if (modelFile)
            config.modelFile = modelFile;
    }
    if (raw.llamaServerHost !== undefined) {
        if (typeof raw.llamaServerHost !== "string" ||
            !LLAMA_SERVER_HOSTS.includes(raw.llamaServerHost)) {
            return null;
        }
        config.llamaServerHost = raw.llamaServerHost;
    }
    if (raw.specType !== undefined) {
        if (typeof raw.specType !== "string" ||
            !LLAMA_SERVER_SPEC_TYPES.includes(raw.specType)) {
            return null;
        }
        config.specType = raw.specType;
    }
    for (const key of ["cacheTypeK", "cacheTypeV"]) {
        const rawValue = raw[key];
        if (rawValue === undefined)
            continue;
        if (typeof rawValue !== "string" ||
            !LLAMA_CACHE_TYPES.includes(rawValue)) {
            return null;
        }
        config[key] = rawValue;
    }
    if (raw.mmprojPath !== undefined) {
        if (!isSafeLlamaModelFile(raw.mmprojPath, process.platform))
            return null;
        const mmprojPath = raw.mmprojPath.trim();
        if (mmprojPath)
            config.mmprojPath = mmprojPath;
    }
    if (raw.loraPath !== undefined) {
        if (!isSafeLlamaModelFile(raw.loraPath, process.platform))
            return null;
        const loraPath = raw.loraPath.trim();
        if (loraPath)
            config.loraPath = loraPath;
    }
    if (config.modelFile !== undefined && config.modelDir === undefined)
        return null;
    return config;
}
