export class BrokerError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = "BrokerError";
  }
}

export class BrokerAuthError extends BrokerError {
  constructor(message = "Broker access token has expired. Please refresh your token.") {
    super(message, "AUTH_EXPIRED");
    this.name = "BrokerAuthError";
  }
}
