import { ZodError, type ZodType } from 'zod'
import { ApiError } from '../services/errors.js'

// Only client input failures are 400; internal response validation remains a server error.
export function parseRequest<T>(schema: ZodType<T>, input: unknown): T {
  try {
    return schema.parse(input)
  } catch (error) {
    if (error instanceof ZodError)
      throw new ApiError(400, 'INVALID_REQUEST', 'Request parameters are invalid')
    throw error
  }
}
