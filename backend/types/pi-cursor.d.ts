declare module "@rahularya01/pi-cursor" {
  type ExtensionApi = {
    registerProvider: (nameOrProvider: string | object, config?: object) => void;
    on?: (...args: unknown[]) => void;
    registerCommand?: (...args: unknown[]) => void;
  };

  const factory: (api: ExtensionApi) => void | Promise<void>;
  export default factory;
}
