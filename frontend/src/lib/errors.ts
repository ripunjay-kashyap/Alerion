export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
    public policyRule?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The operation failed. Please try again.";
}
