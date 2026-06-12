export class RuntimeException extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeException";
  }
}

export class IllegalStateException extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IllegalStateException";
  }
}

export class InvalidArgumentException extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidArgumentException";
  }
}
