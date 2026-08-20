declare module "pi-commandcode-provider" {
  type ExtensionApi = {
    registerProvider: (nameOrProvider: string | object, config?: object) => void;
    on?: (...args: unknown[]) => void;
    registerCommand?: (...args: unknown[]) => void;
  };

  const factory: (api: ExtensionApi) => void | Promise<void>;
  export default factory;
}
