// Owner-handler fixtures use the same URL annotation as Backend's native HTTP adapter.
// This is not a Browser/gateway production dependency or a mocked framework module.
export class BackendTestRequest extends Request {
  readonly nextUrl: URL;
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(input, init);
    this.nextUrl = new URL(this.url);
  }
}
