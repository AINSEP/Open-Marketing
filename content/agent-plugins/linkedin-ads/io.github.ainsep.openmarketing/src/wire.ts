/** Fixed mapping made by the plugin. Body is serialized before any asynchronous work. */
export interface LinkedInWireRequest {
  readonly url: string;
  readonly method: "GET" | "POST" | "PUT";
  readonly restliMethod: "FINDER" | "CREATE" | "PARTIAL_UPDATE" | "UPDATE";
  readonly body?: string;
}
