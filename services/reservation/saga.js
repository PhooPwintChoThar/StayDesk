// Template Method + Command: run booking steps in order and compensate in reverse (NFR-5).
// Mediator: the Reservation Service is the saga orchestrator. Room-Rate, Guest
// and Billing never call each other; all coordination goes through here, so each
// of them stays independent of the others (NFR-7).

export class HttpError extends Error {
  constructor(status, error, message) {
    super(message);
    this.status = status;
    this.error = error;
  }
}

export async function runSaga(steps) {
  const completed = [];
  let context = {};

  try {
    for (const step of steps) {
      const result = await step.execute(context);
      if (result && typeof result === "object") {
        context = { ...context, ...result };
      }
      completed.push(step);
    }
    return context;
  } catch (error) {
    for (const step of completed.reverse()) {
      try {
        await step.compensate?.(context, error);
      } catch (compensateError) {
        console.error(compensateError);
      }
    }
    throw error;
  }
}
