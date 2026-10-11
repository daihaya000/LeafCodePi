import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectRoutes, validateInventory } from "./check-api-ownership.mjs";
import { checkGatewayRuntimePackage, GATEWAY_HTTP_IMPORTS } from "./gateway-runtime-boundary.mjs";
import { checkFrameworkFree } from "./framework-free.mjs";

const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const norm = path => path.replaceAll("\\", "/");
const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, "")));
const forbidden = /^(?:next(?:\/|$)|@backend|@extensions|@earendil-works\/|@rahularya01\/pi-|pi-commandcode|better-sqlite3(?:\/|$))|^(?:backend(?:-core)?|host|extensions)\//;
const loaders = new Set(["require", "eval", "Function", "createRequire", "getBuiltinModule", "_load", "_compile", "compileFunction", "runInContext", "runInNewContext", "runInThisContext", "binding", "_linkedBinding", "dlopen", "loadEnvFile", "WebAssembly", "Worker", "SharedWorker", "importScripts"]);
const globals = new Set(["globalThis", "global", "window", "self"]);
const mutations = new Set(["writeFile", "writeFileSync", "appendFile", "appendFileSync", "createWriteStream", "unlink", "unlinkSync", "rm", "rmSync", "rename", "renameSync", "mkdir", "mkdirSync", "truncate", "truncateSync", "chmod", "chown", "writev"]);
const browserPackages = new Set(["react", "react-dom", "lucide-react", "next-themes", "react-markdown", "remark-gfm"]);
const browserDefines = new Set(["process.env.NODE_ENV", "process.env.NEXT_PUBLIC_LEAFCODE_PI_BUILD_COMMIT", "process.env.NEXT_PUBLIC_LEAFCODE_PI_BUILD_COMMIT_DATE"]);
const parser = () => createRequire(resolve(ROOT, "web/package.json"))("typescript");
const fail = (file, message) => assert.fail(`${file}: ${message}`);

/** Includes erased imports, import(type), references and literal dynamic loaders. */
export function dependencyReferences(source, file = "boundary.ts", ts = parser(), { kind = "gateway", declaration = false, bundled = false, allowMetadata = () => false } = {}) {
  const ast = ts.createSourceFile(resolve(file), source, ts.ScriptTarget.Latest, true);
  assert.equal(ast.parseDiagnostics.length, 0, `${file}: syntax error`);
  const host = ts.createCompilerHost({ noLib: true, noResolve: true });
  host.getSourceFile = name => norm(resolve(name)) === norm(ast.fileName) ? ast : undefined;
  const checker = ts.createProgram([ast.fileName], { noLib: true, noResolve: true, allowJs: true }, host).getTypeChecker();
  const isGlobal = node => ts.isIdentifier(node) && globals.has(node.text)
    && !checker.getSymbolAtLocation(node)?.declarations?.some(d => d.getSourceFile() === ast);
  const unwrap = node => {
    while (node && (ts.isAsExpression(node) || ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node))) node = node.expression;
    return node;
  };
  const aliases = new Set(), reflectionAliases = new Map(), assignedValues = new Map(), globalReturns = new Set();
  const functionAliases = new Set(), prototypeAliases = new Set(), functionReturns = new Set(), prototypeReturns = new Set();
  const argumentSlots = new Map(), variadicSlots = new Map(), parameterValues = new Map(), receiverValues = new Map();
  const returnedBindings = new Map();
  const sameBinding = (a, b) => a.fn === b.fn && Boolean(a.wrapped) === Boolean(b.wrapped) && Boolean(a.boundThis) === Boolean(b.boundThis)
    && a.receiver === b.receiver && a.bound.length === b.bound.length && a.bound.every((value, index) => value === b.bound[index]);
  const localMethod = node => checker.getSymbolAtLocation(node.name)?.declarations?.some(d => d.getSourceFile() === ast);
  const flattenArguments = args => args.flatMap(argument => ts.isSpreadElement(argument) && ts.isArrayLiteralExpression(unwrap(argument.expression)) ? flattenArguments([...unwrap(argument.expression).elements]) : [argument]);
  let bindingCache = new Map();
  const functionBindings = (root, callStack = new Set()) => {
    root = unwrap(root);
    if (!root) return [];
    if (!callStack.size && bindingCache.has(root)) return bindingCache.get(root);
    const targets = [], pending = [{ node: root, wrapped: false, binds: [], symbols: new Set() }], visited = new Map();
    const emit = (binding, state) => {
      binding = { ...binding, wrapped: Boolean(binding.wrapped || state.wrapped) };
      for (const bind of [...state.binds].reverse()) binding = binding.fn === null ? { fn: null, bound: [], wrapped: true }
        : { ...binding, wrapped: true, boundThis: true, receiver: binding.boundThis ? binding.receiver : bind.arguments[0],
          bound: [...binding.bound, ...flattenArguments([...bind.arguments].slice(1))] };
      if (!targets.some(existing => sameBinding(existing, binding))) targets.push(binding);
    };
    while (pending.length) {
      const state = pending.pop(), node = unwrap(state.node);
      if (!node) continue;
      const paths = visited.get(node) ?? [];
      if (paths.some(path => path.wrapped === state.wrapped && path.binds.length === state.binds.length && path.binds.every((bind, index) => bind === state.binds[index]))) continue;
      paths.push(state); visited.set(node, paths);
      const push = (value, extra = {}) => pending.push({ ...state, node: value, ...extra });
      const unknown = () => emit({ fn: null, bound: [] }, state);
      if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) { emit({ fn: node, bound: [] }, state); continue; }
      if (ts.isConditionalExpression(node)) { push(node.whenTrue, { wrapped: true }); push(node.whenFalse, { wrapped: true }); continue; }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.CommaToken) { push(node.right, { wrapped: true }); continue; }
      if (ts.isBinaryExpression(node) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) { push(node.left, { wrapped: true }); push(node.right, { wrapped: true }); continue; }
      if (ts.isPropertyAccessExpression(node) && ["call", "apply"].includes(node.name.text)) { if (localMethod(node)) unknown(); else push(node.expression); continue; }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "bind") {
        if (localMethod(node.expression)) unknown();
        else { assert.ok(!state.binds.includes(node), `${file}: recursive function target analysis forbidden`); push(node.expression.expression, { wrapped: true, binds: [...state.binds, node] }); }
        continue;
      }
      if (ts.isCallExpression(node)) {
        if (callStack.has(node)) { unknown(); continue; }
        const stack = new Set(callStack); stack.add(node);
        for (const call of invocation(node, stack)) for (const binding of returnedBindings.get(call.fn) ?? [{ fn: null, bound: [] }]) emit({ ...binding, wrapped: true }, state);
        continue;
      }
      if (!ts.isIdentifier(node)) { unknown(); continue; }
      const symbol = checker.getSymbolAtLocation(node);
      if (!symbol || state.symbols.has(symbol)) { unknown(); continue; }
      const symbols = new Set(state.symbols); symbols.add(symbol);
      for (const d of symbol.declarations ?? []) {
        if (ts.isFunctionDeclaration(d)) push(d, { symbols });
        else if (ts.isVariableDeclaration(d)) push(d.initializer, { symbols });
        else if (ts.isParameter(d) && d.initializer) push(d.initializer, { symbols, wrapped: true });
        else unknown();
      }
      for (const value of parameterValues.get(symbol) ?? []) push(value, { symbols, wrapped: true });
      for (const value of assignedValues.get(symbol) ?? []) push(value, { symbols });
    }
    const result = targets.length ? targets : [{ fn: null, bound: [] }];
    if (!callStack.size) bindingCache.set(root, result);
    return result;
  };
  const functionTargets = node => [...new Set(functionBindings(node).map(binding => binding.fn))];
  const invocation = (node, seen = new Set()) => {
    const callee = unwrap(node.expression);
    let target = callee, args = [...node.arguments], spreadArray;
    const wrapped = ts.isPropertyAccessExpression(callee) && ["call", "apply", "bind"].includes(callee.name.text);
    if (wrapped) {
      if (localMethod(callee)) return [{ fn: null, args }];
      target = callee.expression;
      const array = unwrap(node.arguments[1]);
      if (callee.name.text === "apply") {
        args = array && ts.isArrayLiteralExpression(array) ? [...array.elements] : [];
        if (array && !ts.isArrayLiteralExpression(array)) spreadArray = array;
      } else args = args.slice(1);
    }
    return functionBindings(target, seen).map(binding => {
      const values = [...binding.bound, ...flattenArguments(args)];
      return { fn: binding.fn, args: values, receiver: binding.boundThis ? binding.receiver : wrapped ? node.arguments[0] : undefined,
        spreadArray, variadic: Boolean(spreadArray) || values.some(ts.isSpreadElement), wrapped: wrapped || binding.wrapped };
    });
  };
  const enclosingFunction = node => {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (ts.isFunctionLike(parent)) return ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent) || ts.isArrowFunction(parent) ? parent : undefined;
    }
  };
  const lexicalArgumentsOwner = node => {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (ts.isArrowFunction(parent)) continue;
      if (ts.isFunctionLike(parent)) return parent;
    }
  };
  const thisValues = node => node.kind === ts.SyntaxKind.ThisKeyword ? [...receiverValues.get(lexicalArgumentsOwner(node)) ?? []] : [];
  const slotValues = (fn, index, start = 0) => [
    ...index === undefined ? [...argumentSlots.get(fn)?.entries() ?? []].filter(([position]) => position >= start).flatMap(([, values]) => [...values]) : [...argumentSlots.get(fn)?.get(index) ?? []],
    // An unknown-length iterable can place each candidate at any later slot.
    // Keep a lower bound, rather than truncating at the declared arity/rest slot.
    ...[...variadicSlots.get(fn)?.entries() ?? []].filter(([position]) => index === undefined || index >= position).flatMap(([, values]) => [...values]),
  ];
  const containerValues = (root, index) => {
    const queue = [root], seen = new Set(), values = new Set();
    // Visit each alias/symbol once, rather than enumerate exponentially many
    // paths through a dense helper DAG. All reachable alternatives are retained.
    while (queue.length) {
      const node = unwrap(queue.pop());
      if (!node || seen.has(node)) continue;
      seen.add(node);
      if (ts.isArrayLiteralExpression(node)) {
        for (const value of index === undefined ? node.elements : node.elements[index] ? [node.elements[index]] : []) {
          if (index === undefined && ts.isSpreadElement(value)) queue.push(value.expression);
          else values.add(value);
        }
      } else if (ts.isConditionalExpression(node)) queue.push(node.whenTrue, node.whenFalse);
      else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.CommaToken) queue.push(node.right);
      else if (ts.isBinaryExpression(node) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) queue.push(node.left, node.right);
      else if (ts.isIdentifier(node)) {
        const symbol = checker.getSymbolAtLocation(node);
        if (node.text === "arguments" && !symbol?.declarations?.some(d => d.getSourceFile() === ast)) {
          for (const value of slotValues(lexicalArgumentsOwner(node), index)) values.add(value);
        } else if (symbol && !seen.has(symbol)) {
          seen.add(symbol);
          for (const d of symbol.declarations ?? []) {
            if (ts.isParameter(d) && d.dotDotDotToken) {
              const start = d.parent.parameters.indexOf(d);
              for (const value of slotValues(d.parent, index === undefined ? undefined : start + index, start)) values.add(value);
            } else if (ts.isVariableDeclaration(d) || ts.isParameter(d)) queue.push(d.initializer);
          }
          queue.push(...assignedValues.get(symbol) ?? [], ...parameterValues.get(symbol) ?? []);
        }
      }
    }
    return [...values];
  };
  const argumentEntries = ({ args, spreadArray }) => {
    const entries = [];
    let index = 0, variadic = false;
    for (const value of args) {
      if (ts.isSpreadElement(value)) {
        variadic = true;
        for (const argument of containerValues(value.expression, undefined)) entries.push({ argument, index, variadic });
      } else {
        entries.push({ argument: value, index, variadic });
        index++;
      }
    }
    if (spreadArray) for (const argument of containerValues(spreadArray, undefined)) entries.push({ argument, index, variadic: true });
    return entries;
  };
  const parameterEntries = call => argumentEntries(call).flatMap(entry => entry.variadic
    ? call.fn.parameters.slice(entry.index).map((parameter, offset) => ({ ...entry, parameter, index: entry.index + offset }))
    : [{ ...entry, parameter: call.fn.parameters[entry.index] }]);
  let projectionCache = new Map();
  const projectedValues = node => {
    if (!ts.isElementAccessExpression(node)) return [];
    if (!projectionCache.has(node)) {
      const key = unwrap(node.argumentExpression);
      const index = key && (ts.isNumericLiteral(key) || ts.isStringLiteralLike(key)) && /^(?:0|[1-9][0-9]*)$/.test(key.text) ? Number(key.text) : undefined;
      projectionCache.set(node, containerValues(node.expression, index));
    }
    return projectionCache.get(node);
  };
  const reflectionKind = node => {
    node = unwrap(node);
    if (!node) return;
    if (ts.isIdentifier(node)) return reflectionAliases.get(checker.getSymbolAtLocation(node));
    if (ts.isPropertyAccessExpression(node)) {
      if (node.name.text === "getOwnPropertyDescriptor") return "descriptor";
      if (node.getText(ast) === "Reflect.get") return "get";
    }
  };
  const globalValue = (node, seen = new Set()) => {
    node = unwrap(node);
    if (!node || seen.has(node)) return false;
    seen.add(node);
    return isGlobal(node) || ts.isIdentifier(node) && aliases.has(checker.getSymbolAtLocation(node))
      || thisValues(node).some(value => globalValue(value, new Set(seen)))
      || projectedValues(node).some(value => globalValue(value, new Set(seen)))
      || ts.isCallExpression(node) && functionTargets(node.expression).some(fn => globalReturns.has(fn))
      || ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.CommaToken && globalValue(node.right, new Set(seen))
      || ts.isConditionalExpression(node) && (globalValue(node.whenTrue, new Set(seen)) || globalValue(node.whenFalse, new Set(seen)))
      || ts.isBinaryExpression(node) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind) && (globalValue(node.left, new Set(seen)) || globalValue(node.right, new Set(seen)));
  };
  const functionValue = (node, seen = new Set(), prototypeOnly = false) => {
    node = unwrap(node);
    if (!node || seen.has(node)) return false;
    seen.add(node);
    if (thisValues(node).some(value => functionValue(value, new Set(seen), prototypeOnly))
      || projectedValues(node).some(value => functionValue(value, new Set(seen), prototypeOnly))) return true;
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isClassExpression(node)) return !prototypeOnly;
    if (ts.isConditionalExpression(node)) return functionValue(node.whenTrue, new Set(seen), prototypeOnly) || functionValue(node.whenFalse, new Set(seen), prototypeOnly);
    if (ts.isBinaryExpression(node)) {
      if (node.operatorToken.kind === ts.SyntaxKind.CommaToken) return functionValue(node.right, seen, prototypeOnly);
      if ([ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) return functionValue(node.left, new Set(seen), prototypeOnly) || functionValue(node.right, new Set(seen), prototypeOnly);
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === "constructor") return !prototypeOnly;
    if (ts.isPropertyAccessExpression(node) && node.name.text === "prototype" && functionValue(node.expression, seen)) return true;
    if (ts.isCallExpression(node)) {
      if (ts.isPropertyAccessExpression(node.expression)) {
        // Every object prototype carries a constructor capability, including Object.prototype.
        if (node.expression.getText(ast) === "Object.getPrototypeOf") return true;
        if (node.expression.name.text === "bind") return !prototypeOnly && functionValue(node.expression.expression, seen);
      }
      if (functionTargets(node.expression).some(fn => (prototypeOnly ? prototypeReturns : functionReturns).has(fn))) return true;
    }
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (!prototypeOnly && !symbol && ["Object", "Array", "String", "Number", "Boolean", "Symbol", "BigInt", "Date", "RegExp", "Promise", "Error", "Map", "Set", "WeakMap", "WeakSet"].includes(node.text)) return true;
      if (symbol && (prototypeAliases.has(symbol) || !prototypeOnly && functionAliases.has(symbol))) return true;
      // Declaration/assignment edges are propagated by the fixed-point binder.
      // Recursively re-expanding them here multiplies dense alias DAG paths.
    }
    if (prototypeOnly) return false;
    const type = checker.getTypeAtLocation(node);
    return type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0;
  };
  // Rollup/vendor DOM fallbacks can bind window/self/globalThis. Track their symbols,
  // rather than exempting all global receiver/alias checks in emitted values.
  {
    let changed;
    do {
      changed = false;
      projectionCache = new Map();
      bindingCache = new Map();
      const bind = node => {
        const name = ts.isVariableDeclaration(node) ? node.name : ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken ? node.left : null;
        const value = ts.isVariableDeclaration(node) ? node.initializer : node.right;
        if (name && ts.isIdentifier(name)) {
          const symbol = checker.getSymbolAtLocation(name), reflected = reflectionKind(value);
          if (symbol && value && ts.isBinaryExpression(node)) {
            if (!assignedValues.has(symbol)) assignedValues.set(symbol, new Set());
            if (!assignedValues.get(symbol).has(value)) {
              assignedValues.get(symbol).add(value); changed = true;
            }
          }
          if (symbol && bundled && globalValue(value) && !aliases.has(symbol)) { aliases.add(symbol); changed = true; }
          if (symbol && value && functionValue(value) && !functionAliases.has(symbol)) { functionAliases.add(symbol); changed = true; }
          if (symbol && value && functionValue(value, new Set(), true) && !prototypeAliases.has(symbol)) { prototypeAliases.add(symbol); changed = true; }
          if (symbol && reflected && (!reflectionAliases.has(symbol) || reflectionAliases.get(symbol) === "descriptor" && reflected === "get")) { reflectionAliases.set(symbol, reflected); changed = true; }
        }
        if (ts.isBindingElement(node) && (node.propertyName ?? node.name).getText(ast) === "getOwnPropertyDescriptor" && ts.isIdentifier(node.name)) {
          const symbol = checker.getSymbolAtLocation(node.name);
          if (symbol && !reflectionAliases.has(symbol)) { reflectionAliases.set(symbol, "descriptor"); changed = true; }
        }
        if (ts.isCallExpression(node)) for (const call of invocation(node).filter(call => call.fn)) {
          const fn = call.fn;
          // Arrows ignore wrapper receivers and inherit their nearest ordinary
          // function's this. Multi-bind/call/apply cannot replace the first bind.
          if (call.receiver && !ts.isArrowFunction(fn)) {
            if (!receiverValues.has(fn)) receiverValues.set(fn, new Set());
            if (!receiverValues.get(fn).has(call.receiver)) { receiverValues.get(fn).add(call.receiver); changed = true; }
          }
          for (const { argument, index, variadic } of argumentEntries(call)) {
            const registry = variadic ? variadicSlots : argumentSlots;
            if (!registry.has(fn)) registry.set(fn, new Map());
            const slots = registry.get(fn);
            if (!slots.has(index)) slots.set(index, new Set());
            if (!slots.get(index).has(argument)) { slots.get(index).add(argument); changed = true; }
          }
          parameterEntries(call).forEach(({ argument, parameter }) => {
            if (parameter && ts.isIdentifier(parameter.name) && !parameter.dotDotDotToken) {
              const symbol = checker.getSymbolAtLocation(parameter.name);
              if (symbol) {
                if (!parameterValues.has(symbol)) parameterValues.set(symbol, new Set());
                if (!parameterValues.get(symbol).has(argument)) { parameterValues.get(symbol).add(argument); changed = true; }
              }
              if (symbol && functionValue(argument) && !functionAliases.has(symbol)) { functionAliases.add(symbol); changed = true; }
              if (symbol && functionValue(argument, new Set(), true) && !prototypeAliases.has(symbol)) { prototypeAliases.add(symbol); changed = true; }
            }
          });
        }
        const returned = ts.isReturnStatement(node) ? node.expression : ts.isArrowFunction(node) && !ts.isBlock(node.body) ? node.body : null;
        if (returned) {
          const fn = ts.isArrowFunction(node) ? node : enclosingFunction(node);
          if (fn) {
            if (!returnedBindings.has(fn)) returnedBindings.set(fn, []);
            const bindings = returnedBindings.get(fn);
            for (const binding of functionBindings(returned)) if (!bindings.some(existing => sameBinding(existing, binding))) {
              assert.ok(bindings.length < 512 && binding.bound.length <= 128, `${file}: recursive/oversized function target analysis forbidden`);
              bindings.push(binding); changed = true;
            }
          }
          if (fn && functionValue(returned) && !functionReturns.has(fn)) { functionReturns.add(fn); changed = true; }
          if (fn && functionValue(returned, new Set(), true) && !prototypeReturns.has(fn)) { prototypeReturns.add(fn); changed = true; }
        }
        if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.initializer) {
          const symbol = checker.getSymbolAtLocation(node.name);
          if (symbol && functionValue(node.initializer) && !functionAliases.has(symbol)) { functionAliases.add(symbol); changed = true; }
          if (symbol && functionValue(node.initializer, new Set(), true) && !prototypeAliases.has(symbol)) { prototypeAliases.add(symbol); changed = true; }
        }
        if (bundled) {
          if (ts.isCallExpression(node)) for (const call of invocation(node).filter(call => call.fn)) {
            parameterEntries(call).forEach(({ argument, parameter }) => {
              if (globalValue(argument) && parameter && ts.isIdentifier(parameter.name) && !parameter.dotDotDotToken) {
                const symbol = checker.getSymbolAtLocation(parameter.name);
                if (symbol && !aliases.has(symbol)) { aliases.add(symbol); changed = true; }
              }
            });
          }
          if (ts.isReturnStatement(node) && globalValue(node.expression)) {
            const fn = enclosingFunction(node);
            if (fn && !globalReturns.has(fn)) { globalReturns.add(fn); changed = true; }
          }
          if (ts.isArrowFunction(node) && !ts.isBlock(node.body) && globalValue(node.body) && !globalReturns.has(node)) {
            globalReturns.add(node); changed = true;
          }
          if (ts.isParameter(node) && ts.isIdentifier(node.name) && globalValue(node.initializer)) {
            const symbol = checker.getSymbolAtLocation(node.name);
            if (symbol && !aliases.has(symbol)) { aliases.add(symbol); changed = true; }
          }
        }
        ts.forEachChild(node, bind);
      };
      bind(ast);
    } while (changed);
  }
  const keyCache = new Map();
  const unknownKey = () => ({ values: new Set(), unknown: true });
  const combineKeys = (left, right, separator = "") => {
    const values = new Set(); let unknown = left.unknown || right.unknown;
    for (const a of left.values) for (const b of right.values) {
      if (a.length + b.length + separator.length > 4096) { unknown = true; continue; }
      const value = a + separator + b;
      if (values.size >= 256 && !loaders.has(value) && value !== "constructor") { unknown = true; continue; }
      values.add(value);
    }
    return { values, unknown };
  };
  const keyCandidates = (root, active = new Set()) => {
    root = unwrap(root);
    if (!root || active.has(root)) return unknownKey();
    if (keyCache.has(root)) return keyCache.get(root);
    const next = new Set(active); next.add(root);
    const evaluate = node => keyCandidates(node, next);
    const union = nodes => {
      const values = new Set(), pending = [...nodes], seen = new Set(); let unknown = false;
      while (pending.length) {
        const node = unwrap(pending.pop());
        if (!node) { unknown = true; continue; }
        if (seen.has(node)) continue;
        seen.add(node);
        if (next.has(node)) { unknown = true; continue; }
        if (ts.isIdentifier(node)) {
          const symbol = checker.getSymbolAtLocation(node);
          const sources = [...symbol?.declarations?.filter(d => ts.isVariableDeclaration(d) || ts.isParameter(d)).flatMap(d => d.initializer ? [d.initializer] : []) ?? [], ...assignedValues.get(symbol) ?? [], ...parameterValues.get(symbol) ?? []];
          if (!sources.length || symbol?.declarations?.some(ts.isParameter)) unknown = true;
          pending.push(...sources); continue;
        }
        if (ts.isConditionalExpression(node)) { pending.push(node.whenTrue, node.whenFalse); continue; }
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.CommaToken) { pending.push(node.right); continue; }
        if (ts.isBinaryExpression(node) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) { unknown = true; pending.push(node.left, node.right); continue; }
        const result = evaluate(node); unknown ||= result.unknown;
        for (const value of result.values) { if (values.size < 256 || loaders.has(value) || value === "constructor") values.add(value); else unknown = true; }
      }
      return nodes.length ? { values, unknown } : unknownKey();
    };
    let result = unknownKey();
    if (ts.isStringLiteralLike(root)) result = { values: new Set([root.text]), unknown: false };
    else if (ts.isConditionalExpression(root)) result = union([root.whenTrue, root.whenFalse]);
    else if (ts.isBinaryExpression(root)) {
      if (root.operatorToken.kind === ts.SyntaxKind.PlusToken) result = combineKeys(evaluate(root.left), evaluate(root.right));
      else if (root.operatorToken.kind === ts.SyntaxKind.CommaToken) result = evaluate(root.right);
      else if ([ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.QuestionQuestionToken].includes(root.operatorToken.kind)) result = { ...union([root.left, root.right]), unknown: true };
    } else if (ts.isIdentifier(root)) {
      const symbol = checker.getSymbolAtLocation(root);
      const values = [...symbol?.declarations?.filter(d => ts.isVariableDeclaration(d) || ts.isParameter(d)).flatMap(d => d.initializer ? [d.initializer] : []) ?? [], ...assignedValues.get(symbol) ?? [], ...parameterValues.get(symbol) ?? []];
      result = union(values);
      // Parameters can also be reached by unmodelled callers; never grant an exact-key permission.
      if (symbol?.declarations?.some(ts.isParameter)) result.unknown = true;
    } else if (ts.isPropertyAccessExpression(root) && localMethod(root)) {
      const symbol = checker.getSymbolAtLocation(root.name);
      result = union(symbol?.declarations?.filter(ts.isPropertyAssignment).map(d => d.initializer) ?? []);
    } else if (ts.isCallExpression(root)) {
      // Synthesized keys are decoded only to add refusals; anything undecodable stays unknown.
      const callee = root.expression, named = ts.isPropertyAccessExpression(callee);
      const called = named ? callee.name.text : ts.isIdentifier(callee) ? callee.text : undefined;
      const receiver = named ? callee.expression : undefined;
      const builtin = named ? !localMethod(callee) : ts.isIdentifier(callee) && !localValue(callee);
      const numbers = node => {
        const value = unwrap(node), array = ts.isSpreadElement(value) ? unwrap(value.expression) : value;
        if (ts.isArrayLiteralExpression(array)) return array.elements.flatMap(element => ts.isSpreadElement(element) ? numbers(element.expression) : [constantNumber(element)]);
        if (ts.isIdentifier(array)) return [...containerValues(array, undefined), ...assignedValues.get(checker.getSymbolAtLocation(array)) ?? []].flatMap(value => [constantNumber(value)]);
        return [constantNumber(value)];
      };
      const codes = root.arguments.flatMap(numbers);
      const offsets = root.arguments.map(constantNumber);
      const source = receiver ? evaluate(receiver) : { values: new Set(), unknown: true };
      const text = source.unknown || source.values.size !== 1 ? undefined : [...source.values][0];
      if (builtin && receiver?.getText(ast) === "String" && ["fromCharCode", "fromCodePoint"].includes(called)
        && codes.length && codes.length <= 64 && codes.every(point => Number.isInteger(point) && point >= 0 && point <= 0x10ffff)) {
        result = { values: new Set([(called === "fromCodePoint" ? String.fromCodePoint : String.fromCharCode)(...codes)]), unknown: false };
      } else if (builtin && ["decodeURIComponent", "decodeURI"].includes(called)
        && root.arguments.length === 1 && staticString(root.arguments[0]) !== undefined) {
        try { result = { values: new Set([(called === "decodeURIComponent" ? decodeURIComponent : decodeURI)(staticString(root.arguments[0]))]), unknown: false }; } catch { /* malformed escapes stay unknown */ }
      } else if (builtin && text !== undefined && ["slice", "substring", "substr", "at", "charAt"].includes(called)
        && offsets.length <= 2 && offsets.every(offset => offset !== undefined)) {
        const value = called === "slice" ? text.slice(offsets[0], offsets[1])
          : called === "substring" ? text.substring(offsets[0], offsets[1])
            : called === "substr" ? text.substr(offsets[0], offsets[1])
              : called === "charAt" ? text.charAt(offsets[0]) : text.at(offsets[0]);
        if (typeof value === "string" && value.length <= 4096) result = { values: new Set([value]), unknown: false };
      } else if (builtin && called === "join") {
        const array = unwrap(receiver);
        if (ts.isArrayLiteralExpression(array) && array.elements.every(node => !ts.isSpreadElement(node) && !ts.isOmittedExpression(node))) {
          const separator = root.arguments.length ? evaluate(root.arguments[0]) : { values: new Set([","]), unknown: false };
          result = { values: new Set(), unknown: separator.unknown || root.arguments.length > 1 };
          for (const sep of separator.values) {
            let joined = { values: new Set([""]), unknown: false };
            array.elements.forEach((node, index) => { joined = combineKeys(joined, evaluate(node), index ? sep : ""); });
            result.unknown ||= joined.unknown; for (const value of joined.values) result.values.add(value);
          }
        }
      }
    }
    // Cache only complete root queries. Cyclic/context-dependent subqueries must not hide alternatives.
    if (active.size === 0 || !result.unknown) keyCache.set(root, result);
    return result;
  };
  // Candidate decoding adds refusals only; do not widen any exact-key permission.
  const staticString = node => {
    node = unwrap(node);
    if (node && ts.isStringLiteralLike(node)) return node.text;
    if (node && ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = staticString(node.left), right = staticString(node.right);
      if (left !== undefined && right !== undefined) return left + right;
    }
  };
  // Constant-fold only arithmetic the decoder can trust; anything else stays unknown.
  const constantNumber = node => {
    node = unwrap(node);
    if (!node) return undefined;
    if (ts.isNumericLiteral(node)) { const value = Number(node.text); return Number.isFinite(value) ? value : undefined; }
    if (ts.isPrefixUnaryExpression(node) && [ts.SyntaxKind.MinusToken, ts.SyntaxKind.PlusToken].includes(node.operator)) {
      const value = constantNumber(node.operand);
      return value === undefined ? undefined : node.operator === ts.SyntaxKind.MinusToken ? -value : value;
    }
    if (ts.isBinaryExpression(node)) {
      const left = constantNumber(node.left), right = constantNumber(node.right);
      if (left === undefined || right === undefined) return undefined;
      const value = node.operatorToken.kind === ts.SyntaxKind.PlusToken ? left + right
        : node.operatorToken.kind === ts.SyntaxKind.MinusToken ? left - right
          : node.operatorToken.kind === ts.SyntaxKind.AsteriskToken ? left * right
            : node.operatorToken.kind === ts.SyntaxKind.SlashToken ? left / right
              : node.operatorToken.kind === ts.SyntaxKind.PercentToken ? left % right
                : node.operatorToken.kind === ts.SyntaxKind.AsteriskAsteriskToken ? left ** right : undefined;
      return Number.isFinite(value) && Math.abs(value) <= 0xffffffff ? value : undefined;
    }
  };
  const localValue = node => ts.isIdentifier(node) && checker.getSymbolAtLocation(node)?.declarations?.some(d => d.getSourceFile() === ast);
  const forbiddenKey = node => [...keyCandidates(node).values].some(key => loaders.has(key) || key === "constructor");
  function constructorMetadata(node) {
    if (!bundled) return false;
    const parent = node.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === node && parent.name.text === "prototype") return true;
    if (ts.isBinaryExpression(parent) && parent.left === node && [ts.SyntaxKind.EqualsToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(parent.operatorToken.kind)) return true;
    // Only source-map-verified, byte-pinned React sites may use this shape.
    // An untrusted function can masquerade as an Event and expose Function.
    return allowMetadata("constructor", node) && ts.isNewExpression(parent) && parent.expression === node && ts.isIdentifier(node.expression)
      && parent.arguments?.length === 2 && ts.isPropertyAccessExpression(parent.arguments[0])
      && parent.arguments[0].name.text === "type" && parent.arguments[0].expression.getText(ast) === node.expression.getText(ast)
      && parent.arguments[1].getText(ast) === node.expression.getText(ast);
  }
  function guardedCloneConstructor(node) {
    if (!bundled || !ts.isNewExpression(node.parent) || node.parent.expression !== node || node.parent.arguments?.length !== 1) return false;
    const returned = node.parent.parent, body = returned.parent, fn = body.parent;
    if (!ts.isReturnStatement(returned) || !ts.isBlock(body) || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))
      || fn.parameters.length !== 2 || body.statements.length !== 2 || !ts.isSwitchStatement(body.statements[0])) return false;
    const [key, value] = fn.parameters.map(parameter => parameter.name.getText(ast)), guard = body.statements[0];
    if (node.argumentExpression.getText(ast) !== key || node.parent.arguments[0].getText(ast) !== value || guard.expression.getText(ast) !== key) return false;
    const cases = guard.caseBlock.clauses;
    const blocked = ["Function", "SharedWorker", "Worker", "eval", "setInterval", "setTimeout"];
    return cases.length === blocked.length && cases.every((clause, index) => ts.isCaseClause(clause)
      && staticString(clause.expression) === blocked[index] && (index < cases.length - 1 ? clause.statements.length === 0
        : clause.statements.length === 1 && ts.isThrowStatement(clause.statements[0])
          && ts.isNewExpression(clause.statements[0].expression) && clause.statements[0].expression.expression.getText(ast) === "TypeError"));
  }
  // @ungap/structured-clone probes a type, then uses the exact guarded constructor above.
  // typeof alone does not expose a callable; arbitrary extraction/altered guards still fail.
  const computedMetadata = node => bundled && (ts.isTypeOfExpression(node.parent) || guardedCloneConstructor(node) || allowMetadata("global-read", node));
  const references = [];
  function add(node, typeOnly = false) {
    assert.ok(node && ts.isStringLiteralLike(node), `${file}: nonliteral module loading is forbidden`);
    references.push({ specifier: node.text, typeOnly });
  }
  // Assignment/iteration destructuring uses ObjectLiteralExpression, not BindingElement.
  // Walk nested patterns only; normal computed object construction is not extraction.
  const assignmentPattern = node => {
    let pattern = node.parent;
    while (pattern && (ts.isObjectLiteralExpression(pattern) || ts.isArrayLiteralExpression(pattern)
      || ts.isPropertyAssignment(pattern) || ts.isSpreadAssignment(pattern) || ts.isSpreadElement(pattern)
      || ts.isParenthesizedExpression(pattern))) {
      const parent = pattern.parent;
      if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.left === pattern
        || (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) && parent.initializer === pattern) return true;
      pattern = parent;
    }
    return false;
  };
  function visit(node, inType = false) {
    inType ||= declaration || ts.isTypeNode(node);
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause, named = clause?.namedBindings;
      const erased = clause?.isTypeOnly || clause && !clause.name && named && ts.isNamedImports(named) && named.elements.length > 0 && named.elements.every(e => e.isTypeOnly);
      add(node.moduleSpecifier, Boolean(erased));
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const named = node.exportClause;
      add(node.moduleSpecifier, node.isTypeOnly || Boolean(named && ts.isNamedExports(named) && named.elements.length > 0 && named.elements.every(e => e.isTypeOnly)));
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression, node.isTypeOnly);
    if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) add(node.name, true);
    if (ts.isImportTypeNode(node)) { assert.ok(ts.isLiteralTypeNode(node.argument), `${file}: nonliteral import type`); add(node.argument.literal, true); }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node.arguments[0]);
    if (!inType) {
      if (kind === "gateway" && ts.isIdentifier(node) && (mutations.has(node.text) || norm(file).endsWith("gateway/src/static.mjs") && node.text === "write")) fail(file, `store/filesystem mutation forbidden: ${node.text}`);
      const extractedName = ts.isBindingElement(node) ? node.propertyName ?? node.name
        : (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && assignmentPattern(node) ? node.name : null;
      if (extractedName) {
        const computed = ts.isComputedPropertyName(extractedName);
        const key = computed ? staticString(extractedName.expression)
          : ts.isIdentifier(extractedName) || ts.isStringLiteralLike(extractedName) ? extractedName.text : undefined;
        if (computed && key === undefined && !ts.isNumericLiteral(unwrap(extractedName.expression))
          || loaders.has(key) || key === "constructor") fail(file, "destructured loader/code evaluation alias forbidden");
        // Identifier descriptor bindings are tracked above. Other extraction shapes
        // must not create an untracked reflection getter.
        if (["get", "getOwnPropertyDescriptor"].includes(key) && !(ts.isBindingElement(node)
          && ts.isIdentifier(extractedName) && key === "getOwnPropertyDescriptor")) fail(file, "destructured reflection loader alias forbidden");
      }
      if (ts.isIdentifier(node) && node.text === "Reflect" && !checker.getSymbolAtLocation(node)?.declarations?.some(d => d.getSourceFile() === ast)) {
        const parent = node.parent;
        assert.ok(ts.isPropertyAccessExpression(parent) || ts.isTypeOfExpression(parent), `${file}: reflected loader namespace alias forbidden`);
      }
      if (ts.isIdentifier(node) && loaders.has(node.text)) fail(file, `indirect loader/code evaluation forbidden: ${node.text}`);
      if (ts.isPropertyAccessExpression(node) && (loaders.has(node.name.text) || node.name.text === "constructor" && !constructorMetadata(node) || node.getText(ast).startsWith("import.meta.glob"))) fail(file, `indirect loader/code evaluation forbidden: ${node.getText(ast).slice(0,100)}`);
      if (ts.isElementAccessExpression(node) && (forbiddenKey(node.argumentExpression) || functionValue(node.expression) && staticString(node.argumentExpression) === undefined && !ts.isNumericLiteral(unwrap(node.argumentExpression)) && !(bundled && (allowMetadata("global-read", node) || allowMetadata("function-read", node))) || globalValue(node.expression) && !computedMetadata(node))) fail(file, `computed loader/global access forbidden: ${node.getText(ast).slice(0,100)}`);
      if (reflectionKind(node)) {
        const parent = node.parent;
        assert.ok(ts.isCallExpression(parent) && parent.expression === node || ts.isVariableDeclaration(parent)
          || ts.isBindingElement(parent) || ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
          || ts.isTypeOfExpression(parent) || ts.isIfStatement(parent) && parent.expression === node
          || ts.isConditionalExpression(parent) && parent.condition === node || ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken
          || ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken,
        `${file}: reflected loader alias escape forbidden: ${parent.getText(ast).slice(0,100)}`);
      }
      if (ts.isCallExpression(node) && (reflectionKind(node.expression)
        || ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "get" && globalValue(node.arguments[0]))) {
        const key = staticString(node.arguments[1]);
        const descriptor = bundled && reflectionKind(node.expression) === "descriptor" && allowMetadata("descriptor", node);
        const intrinsicMapGet = bundled && allowMetadata("global-map-get", node) && !reflectionKind(node.expression);
        assert.ok(intrinsicMapGet || (descriptor || key !== undefined) && !loaders.has(key) && key !== "constructor" && !globalValue(node.arguments[0]), `${file}: reflected loader/global access forbidden: ${node.expression.getText(ast)}`);
      }
      if (isGlobal(node) || bundled && ts.isIdentifier(node) && aliases.has(checker.getSymbolAtLocation(node))) {
        let receiver = node;
        // Inspect the consumer of a conditional/logical global value too, so a
        // nested expression cannot hide it inside an untracked object/array.
        for (;;) {
          const parent = receiver.parent;
          if (ts.isAsExpression(parent) || ts.isParenthesizedExpression(parent) || ts.isNonNullExpression(parent)
            || ts.isConditionalExpression(parent) && (parent.whenTrue === receiver || parent.whenFalse === receiver)
            || ts.isBinaryExpression(parent) && ([ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.QuestionQuestionToken].includes(parent.operatorToken.kind)
              || parent.operatorToken.kind === ts.SyntaxKind.CommaToken && parent.right === receiver)) receiver = parent;
          else break;
        }
        const direct = (ts.isPropertyAccessExpression(receiver.parent) || ts.isElementAccessExpression(receiver.parent) && computedMetadata(receiver.parent)) && receiver.parent.expression === receiver;
        const typeOf = ts.isTypeOfExpression(receiver.parent);
        const named = node.parent.name === node && !ts.isShorthandPropertyAssignment(node.parent);
        const parent = receiver.parent;
        const flow = bundled && ((ts.isVariableDeclaration(parent) || ts.isParameter(parent)) && parent.initializer === receiver && ts.isIdentifier(parent.name)
          || ts.isReturnStatement(parent) && enclosingFunction(parent)
          || ts.isArrowFunction(parent) && parent.body === receiver
          || ts.isConditionalExpression(parent) && parent.condition === receiver
          || ts.isBinaryExpression(parent) && (parent.operatorToken.kind === ts.SyntaxKind.PlusToken
            && (ts.isStringLiteralLike(unwrap(parent.left)) || ts.isStringLiteralLike(unwrap(parent.right)))
            || parent.operatorToken.kind === ts.SyntaxKind.CommaToken && parent.left === receiver
            || parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(parent.left)
            || [ts.SyntaxKind.InKeyword, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(parent.operatorToken.kind))
          || (ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent) || ts.isSwitchStatement(parent)) && parent.expression === receiver
          || ts.isForStatement(parent) && parent.condition === receiver
          || ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken);
        // A global argument is permitted only when every possible local target
        // has a symbol-tracked positional parameter. Unknown/rest/object escape fails closed.
        const calls = ts.isCallExpression(parent) ? invocation(parent) : [];
        // Normalize wrappers for capability propagation, never as a new global
        // escape permission: prototype mutation can replace call/apply/bind.
        const localCall = bundled && calls.length > 0 && calls.every(({ fn, args, wrapped, variadic }) => {
          const argumentIndex = args.indexOf(receiver), parameter = fn?.parameters[argumentIndex];
          return !wrapped && !variadic && argumentIndex >= 0 && fn?.body && parameter && ts.isIdentifier(parameter.name) && !parameter.dotDotDotToken;
        });
        // Fixed React source legitimately passes DOM/window values to callbacks
        // and SyntheticEvents. This is origin/hash-bound, not a call-shape exemption;
        // computed loaders/reflection/constructors above still fail independently.
        const trustedFlow = bundled && allowMetadata("global-flow", node);
        assert.ok(direct || typeOf || named || flow || localCall || trustedFlow, `${file}: global loader alias/destructuring forbidden: ${parent.getText(ast).slice(0,100)}`);
      }
      if (!bundled && kind === "browser" && ts.isIdentifier(node) && node.text === "process") {
        let parent = node; while (ts.isPropertyAccessExpression(parent.parent) && parent.parent.expression === parent) parent = parent.parent;
        assert.ok(browserDefines.has(parent.getText(ast)), `${file}: Node process capability forbidden`);
      }
    }
    if (kind === "browser" && ts.isIdentifier(node) && node.text === "NodeJS") fail(file, "Node type dependency forbidden");
    ts.forEachChild(node, child => visit(child, inType));
  }
  visit(ast);
  for (const item of ast.typeReferenceDirectives) references.push({ specifier: item.fileName === "node" ? "node:types" : item.fileName, typeOnly: true, typeReference: true });
  for (const item of ast.referencedFiles) references.push({ specifier: item.fileName, typeOnly: true, pathReference: true });
  return references;
}

export function checkSpecifier(specifier, kind, file) {
  assert.ok(!forbidden.test(norm(specifier)), `${file}: forbidden value/type dependency ${specifier}`);
  if (kind === "browser") assert.ok(!specifier.startsWith("node:") && !builtins.has(specifier), `${file}: Node dependency forbidden: ${specifier}`);
}

export function checkProductionFile(file, root, kind, { packageFile = false, tsLib = false } = {}) {
  const canonical = realpathSync(file);
  let name = norm(relative(root, file));
  const key = path => process.platform === "win32" ? norm(path).toLowerCase() : norm(path);
  if (packageFile && !tsLib) {
    // Compiler dependencies may be borrowed by isolated fixtures, but only from this
    // checker's own installed Web packages, never a caller-selected owner directory.
    const approved = [resolve(root, "web/node_modules"), resolve(ROOT, "web/node_modules")].find(base => {
      const rel = relative(base, canonical); return rel && !rel.startsWith("..") && !isAbsolute(rel);
    });
    assert.ok(approved, `${name}: package symlink escape`);
    name = "web/node_modules/" + norm(relative(approved, canonical));
  } else assert.equal(key(canonical), key(resolve(file)), `${name}: symlink escape`);
  if (tsLib) return;
  assert.ok(!isAbsolute(name) && !name.startsWith("../"), `${name}: production closure escaped checkout`);
  assert.ok(!forbidden.test(name) && !/(?:^|\/)(?:node_modules\/next\/|node_modules\/@earendil-works\/)|\.test\./.test(name), `${name}: forbidden production source`);
  if (packageFile) {
    assert.ok(name.startsWith("web/node_modules/"), `${name}: unexpected package root`);
    const packageName = name.match(/^web\/node_modules\/((?:@[^/]+\/)?[^/]+)/)?.[1];
    checkSpecifier(packageName ?? "", kind, name);
    if (kind === "gateway") assert.ok(["@types/node", "undici-types", "undici"].includes(packageName), `${name}: unexpected gateway type package`);
    if (kind === "browser") assert.ok(!/\/node_modules\/(?:@types\/node|undici(?:-types)?)(?:\/|$)/.test("/" + name), `${name}: Node type dependency forbidden`);
    return;
  }
  const allowed = kind === "browser" ? ["web/src/", "shared/"] : ["gateway/src/", "web/src/app/api/", "web/src/lib/", "shared/"];
  assert.ok(allowed.some(prefix => name.startsWith(prefix)) || kind === "browser" && name === "web/index.html", `${name}: forbidden owner source`);
  if (kind === "gateway" && ["shared/", "web/src/lib/"].some(prefix => name.startsWith(prefix))) {
    const policyFile = resolve(ROOT, "scripts/gateway-contracts.json"), policy = JSON.parse(readFileSync(policyFile, "utf8"));
    assert.equal(policy.version, 1, "Unsupported gateway contract policy");
    assert.ok(policy.files.includes(name), `${name}: unaudited owner/store/contract dependency`);
  }
  if (kind === "browser") assert.ok(!name.startsWith("web/src/app/api/") && !name.startsWith("web/src/platform/"), `${name}: forbidden Browser transport/framework source`);
  assert.ok(!name.startsWith("web/src/lib/pi/") || kind === "browser" && name === "web/src/lib/pi/messages.ts", `${name}: forbidden compatibility owner source`);
}

function compilerOptions(root, kind, ts) {
  if (kind === "browser") {
    const path = resolve(root, "web/tsconfig.spa.json"), config = ts.readConfigFile(path, ts.sys.readFile);
    assert.equal(config.error, undefined);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, resolve(root, "web"), undefined, path);
    assert.equal(parsed.errors.length, 0); return parsed;
  }
  return { options: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true,
    noEmit: true, skipLibCheck: true, allowJs: true, esModuleInterop: true, resolveJsonModule: true, baseUrl: resolve(root, "web"),
    paths: { "@/*": ["src/*"], "@shared/*": ["../shared/*"] }, types: ["node"], typeRoots: [resolve(root, "web/node_modules/@types")] } };
}

function gatewayCapability(file, specifier, ts, source) {
  const cap = file === "web/src/lib/gateway-http.mjs" ? GATEWAY_HTTP_IMPORTS
    : file === "gateway/src/static.mjs" ? ["node:fs", "node:fs/promises", "node:crypto", "node:path"]
    : file.startsWith("gateway/") ? ["node:http", "node:stream", "node:events"]
    : file === "shared/host-http-client.ts" ? ["node:fs", "node:os", "node:path"]
    : file === "shared/backend-http-client.ts" ? ["node:fs"]
    : file === "shared/webui-presentation.mjs" ? ["node:os"]
    : ["node:crypto", "node:zlib"];
  assert.ok(cap.includes(specifier), `${file}: forbidden gateway OS/store capability ${specifier}`);
  if (file === "gateway/src/static.mjs" && ["node:fs", "node:fs/promises"].includes(specifier)) {
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const imports = ast.statements.filter(n => ts.isImportDeclaration(n) && n.moduleSpecifier.text === specifier);
    const allowed = specifier === "node:fs" ? ["constants"] : ["lstat", "open", "readdir", "realpath"];
    assert.equal(imports.length, 1, "Static snapshot requires one named read-only filesystem import");
    const clause = imports[0].importClause, bindings = clause?.namedBindings;
    assert.ok(!clause.name && bindings && ts.isNamedImports(bindings) && bindings.elements.every(e => allowed.includes(e.name.text) && !e.propertyName), "Static snapshot may acquire only audited read-only filesystem capabilities");
    if (specifier === "node:fs/promises") {
      function audit(node) {
        if (ts.isIdentifier(node) && node.text === "open") {
          const direct = ts.isCallExpression(node.parent) && node.parent.expression === node;
          const imported = ts.isImportSpecifier(node.parent) && node.parent.name === node;
          assert.ok(direct || imported, "Static snapshot open aliases are forbidden");
          if (direct) assert.equal(node.parent.arguments[1]?.getText(ast).replace(/\s+/g, ""), "constants.O_RDONLY|(constants.O_NOFOLLOW??0)", "Static snapshot open must use audited read-only flags");
        }
        ts.forEachChild(node, audit);
      }
      audit(ast);
    }
  }
  if (specifier === "node:fs" && ["shared/host-http-client.ts", "shared/backend-http-client.ts"].includes(file)) {
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const imports = ast.statements.filter(n => ts.isImportDeclaration(n) && n.moduleSpecifier.text === specifier);
    assert.equal(imports.length, 1, `${file}: only one generation/discovery reader allowed`);
    const clause = imports[0].importClause, bindings = clause?.namedBindings;
    assert.ok(!clause.name && bindings && ts.isNamedImports(bindings) && bindings.elements.length === 1 && bindings.elements[0].name.text === "readFileSync" && !bindings.elements[0].propertyName, `${file}: only readFileSync metadata capability allowed`);
  }
}

/** First-party executable graph + complete compiler-resolved type graph (including packages). */
export function checkProductionBoundary(root = ROOT, kind = "browser", { ts = parser(), entries, virtual = new Map(), diagnostics = true, reportFiles = false } = {}) {
  root = realpathSync(root);
  const config = compilerOptions(root, kind, ts), options = config.options;
  entries ??= kind === "browser" ? config.fileNames : [resolve(root, "gateway/src/index.mjs")];
  const sources = new Map(), runtimeImports = new Set();
  function implementation(file, specifier) {
    const parsed = ts.resolveModuleName(specifier, file, options, ts.sys).resolvedModule;
    const raw = specifier.startsWith(".") ? resolve(dirname(file), specifier)
      : specifier.startsWith("@shared/") ? resolve(root, "shared", specifier.slice(8))
      : specifier.startsWith("@/") ? resolve(root, "web/src", specifier.slice(2)) : null;
    if (parsed && /\.d\.[cm]ts$/.test(parsed.resolvedFileName)) {
      const runtime = parsed.resolvedFileName.replace(/\.d\.(m|c)ts$/, ".$1js");
      if (existsSync(runtime) && statSync(runtime).isFile()) return runtime;
    }
    if (raw && /\.[cm]?js$/.test(specifier) && existsSync(raw) && statSync(raw).isFile()) return raw;
    if (raw && virtual.has(raw)) return raw;
    if (parsed && !/\.d\.[cm]?ts$/.test(parsed.resolvedFileName)) return parsed.resolvedFileName;
    if (raw && /\.(?:css|svg|png|webp|jpg)$/.test(raw) && existsSync(raw)) return raw;
    assert.fail(`${file}: unresolved runtime dependency ${specifier}`);
  }
  function visit(file) {
    file = resolve(file); if (sources.has(file)) return;
    if (!virtual.has(file)) checkProductionFile(file, root, kind);
    const source = virtual.get(file) ?? readFileSync(file, "utf8"); sources.set(file, source);
    if (/\.(?:css|svg|png|webp|jpg)$/.test(file)) return;
    for (const edge of dependencyReferences(source, norm(relative(root, file)), ts, { kind, declaration: /\.d\.[cm]?ts$/.test(file) })) {
      checkSpecifier(edge.specifier, kind, file);
      if (kind === "gateway" && (edge.specifier.startsWith("node:") || builtins.has(edge.specifier))) gatewayCapability(norm(relative(root, file)), edge.specifier, ts, source);
      const external = !edge.specifier.startsWith(".") && !edge.specifier.startsWith("@/") && !edge.specifier.startsWith("@shared/") && !isAbsolute(edge.specifier);
      if (external && !edge.typeOnly) {
        if (kind === "browser") assert.ok(browserPackages.has(edge.specifier.split("/").slice(0, edge.specifier.startsWith("@") ? 2 : 1).join("/")), `${file}: unexpected Browser runtime package ${edge.specifier}`);
        else { gatewayCapability(norm(relative(root, file)), edge.specifier, ts, source); if (!edge.specifier.startsWith("node:") && !builtins.has(edge.specifier)) runtimeImports.add(edge.specifier); }
        continue;
      }
      if (!edge.typeOnly) visit(implementation(file, edge.specifier));
    }
  }
  entries.forEach(visit);
  const host = ts.createCompilerHost(options), originalRead = host.readFile, originalExists = host.fileExists;
  host.readFile = file => virtual.get(resolve(file)) ?? originalRead(file);
  host.fileExists = file => virtual.has(resolve(file)) || originalExists(file);
  const program = ts.createProgram([...sources.keys()].filter(file => !/\.(?:css|svg|png|webp|jpg)$/.test(file)), options, host);
  const libRoot = dirname(ts.getDefaultLibFilePath(options));
  for (const file of program.getSourceFiles()) {
    const tsLib = dirname(file.fileName) === libRoot, packageFile = norm(file.fileName).includes("/node_modules/");
    if (!virtual.has(resolve(file.fileName))) checkProductionFile(file.fileName, root, kind, { packageFile, tsLib });
    if (tsLib) continue;
    if (packageFile && kind === "gateway") {
      // skipLibCheck must not erase forbidden or unresolved imports in vendor declarations.
      const base = norm(file.fileName).match(/^(.*\/node_modules\/(?:(?:@[^/]+\/)?[^/]+))\//)?.[1];
      for (const edge of dependencyReferences(file.text, file.fileName, ts, { kind, declaration: true })) {
        checkSpecifier(edge.specifier, kind, file.fileName);
        if (edge.pathReference || edge.specifier.startsWith(".") || isAbsolute(edge.specifier)) {
          const name = relative(base, resolve(dirname(file.fileName), edge.specifier));
          assert.ok(name && !name.startsWith("..") && !isAbsolute(name), `${file.fileName}: gateway package type escape`);
        } else assert.ok(edge.specifier.startsWith("node:") || builtins.has(edge.specifier) || /^(?:undici(?:-types)?(?:\/|$)|@types\/node(?:\/|$))/.test(edge.specifier), `${file.fileName}: unaudited gateway type dependency ${edge.specifier}`);
      }
      continue;
    }
    for (const edge of dependencyReferences(file.text, file.fileName, ts, { kind, declaration: file.isDeclarationFile })) {
      checkSpecifier(edge.specifier, kind, file.fileName);
      if (kind === "gateway" && (edge.specifier.startsWith("node:") || builtins.has(edge.specifier))) gatewayCapability(norm(relative(root, file.fileName)), edge.specifier, ts, file.text);
    }
  }
  if (diagnostics) {
    const errors = ts.getPreEmitDiagnostics(program);
    assert.equal(errors.length, 0, ts.formatDiagnosticsWithColorAndContext(errors, { getCurrentDirectory: () => root, getCanonicalFileName: name => name, getNewLine: () => "\n" }));
  }
  const runtimePackages = kind === "gateway" && runtimeImports.size ? checkGatewayRuntimePackage(root, { imports: [...runtimeImports], ts, reportFiles }) : {};
  return { runtimeSources: sources.size, typeSources: program.getSourceFiles().length, ...runtimePackages,
    ...(reportFiles ? { runtimeFiles: [...sources.keys()].map(file => norm(relative(root, file))).sort(), typeFiles: program.getSourceFiles().map(file => norm(relative(root, file.fileName))).filter(file => !file.includes("node_modules/")).sort() } : {}) };
}

export function checkBrowserBoundary(root = ROOT, options = {}) { return checkProductionBoundary(root, "browser", options); }
export function checkGatewayBoundary(root = ROOT, options = {}) {
  const routes = collectRoutes(root), counts = validateInventory(JSON.parse(readFileSync(resolve(root, "docs/plans/next-thin-phase0.json"), "utf8")), routes);
  const source = "export const routes = [\n" + [...routes].map(([route, record]) => ` { route: ${JSON.stringify(route)}, methods: ${JSON.stringify(record.methods)}, load: () => import(${JSON.stringify("../../" + record.source)}) },`).join("\n") + "\n];\n";
  return { ...counts, ...checkProductionBoundary(root, "gateway", { ...options, virtual: new Map([[resolve(root, "gateway/src/routes.mjs"), source]]) }) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    assert.ok(args.length === 0 || args.length === 1 && ["--browser", "--gateway"].includes(args[0]), "Unsupported production boundary option");
    console.log(JSON.stringify({ framework: checkFrameworkFree(), ...(args[0] !== "--gateway" ? { browser: checkBrowserBoundary() } : {}), ...(args[0] !== "--browser" ? { gateway: checkGatewayBoundary() } : {}) }));
  }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
