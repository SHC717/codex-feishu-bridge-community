import { randomUUID } from 'node:crypto';

const EVENT_FIELDS = new Set([
  'type', 'event_type', 'event_id', 'operator_id', 'message_id',
  'action_value', 'form_value',
]);
const ACTION_FIELDS = new Set(['question_id', 'choice']);
const FORM_FIELDS = new Set(['answer']);

function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function nonblank(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseObject(value, allowedFields) {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    if (!plainObject(parsed)) return null;
    if (Object.keys(parsed).some((key) => !allowedFields.has(key))) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Local, in-memory question/answer state. No network, file I/O, command execution,
 * credentials, or Codex access. Answers are opaque data, never instructions.
 *
 * Expected projected event:
 * {
 *   type: 'card.action.trigger',
 *   operator_id: 'ou_...',
 *   message_id: 'om_...',
 *   action_value: JSON.stringify({ question_id: '...', choice: 'A' }),
 *   form_value: JSON.stringify({ answer: 'optional free text' })
 * }
 *
 * "event_type" is also accepted; if both type fields exist they must agree.
 * Only the projected fields above plus optional event_id are accepted.
 * question_id belongs in action_value even for a text-only submission.
 * Message binding can happen after sending the card, before accepting a reply.
 * Callers own delivery, authentication of the transport, and persistence.
 */
export class QuestionBridge {
  #questions = new Map();
  #clock;

  constructor({ clock = Date.now } = {}) {
    if (typeof clock !== 'function') throw new TypeError('clock must be a function');
    this.#clock = clock;
  }

  #now() {
    const now = this.#clock();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new TypeError('clock must return non-negative integer epoch milliseconds');
    }
    return now;
  }

  createQuestion({
    prompt,
    expectedOperatorId,
    expectedMessageId = null,
    choices = [],
    ttlMs = 10 * 60 * 1000,
  } = {}) {
    if (!nonblank(prompt)) throw new TypeError('prompt must be nonblank text');
    if (!nonblank(expectedOperatorId)) {
      throw new TypeError('expectedOperatorId must be nonblank text');
    }
    if (expectedMessageId !== null && !nonblank(expectedMessageId)) {
      throw new TypeError('expectedMessageId must be null or nonblank text');
    }
    if (!Array.isArray(choices) || choices.some((choice) => !nonblank(choice))) {
      throw new TypeError('choices must be an array of nonblank strings');
    }
    if (new Set(choices).size !== choices.length) {
      throw new TypeError('choices must be unique');
    }
    const createdAt = this.#now();
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0
      || !Number.isSafeInteger(createdAt + ttlMs)) {
      throw new RangeError('ttlMs must produce a future safe integer expiry');
    }

    let questionId;
    do { questionId = randomUUID(); } while (this.#questions.has(questionId));
    const record = {
      questionId,
      prompt,
      expectedOperatorId,
      expectedMessageId,
      choices: [...choices],
      createdAt,
      expiresAt: createdAt + ttlMs,
      answeredAt: null,
      answer: null,
    };
    this.#questions.set(questionId, record);
    return this.#view(record, createdAt);
  }

  bindMessage(questionId, messageId) {
    const record = this.#questions.get(questionId);
    if (!record) throw new RangeError('unknown question');
    if (!nonblank(messageId)) throw new TypeError('messageId must be nonblank text');
    const now = this.#now();
    if (record.answeredAt !== null) throw new Error('question already answered');
    if (now >= record.expiresAt) throw new Error('question expired');
    if (record.expectedMessageId !== null) throw new Error('message already bound');
    record.expectedMessageId = messageId;
    return this.#view(record, now);
  }

  receive(event) {
    const reject = (code, questionId) => ({
      accepted: false, code, ...(questionId === undefined ? {} : { questionId }),
    });

    if (!plainObject(event)
      || Object.keys(event).some((key) => !EVENT_FIELDS.has(key))) {
      return reject('invalid_projection');
    }
    const eventType = event.type ?? event.event_type;
    if (eventType !== 'card.action.trigger'
      || (event.type !== undefined && event.event_type !== undefined
        && event.type !== event.event_type)) {
      return reject('invalid_event_type');
    }
    if (!nonblank(event.operator_id) || !nonblank(event.message_id)) {
      return reject('invalid_identity');
    }

    const action = parseObject(event.action_value, ACTION_FIELDS);
    if (!action || !nonblank(action.question_id)) return reject('invalid_action');
    const questionId = action.question_id;
    const record = this.#questions.get(questionId);
    if (!record) return reject('unknown_question', questionId);
    if (event.operator_id !== record.expectedOperatorId) {
      return reject('operator_mismatch', questionId);
    }
    if (record.expectedMessageId === null) return reject('message_unbound', questionId);
    if (event.message_id !== record.expectedMessageId) {
      return reject('message_mismatch', questionId);
    }
    if (record.answeredAt !== null) return reject('duplicate', questionId);
    const now = this.#now();
    if (now >= record.expiresAt) return reject('expired', questionId);

    let choice = null;
    if (Object.hasOwn(action, 'choice')) {
      if (!nonblank(action.choice) || !record.choices.includes(action.choice)) {
        return reject('invalid_choice', questionId);
      }
      choice = action.choice;
    }

    let text = null;
    if (event.form_value !== undefined && event.form_value !== null
      && event.form_value !== '') {
      const form = parseObject(event.form_value, FORM_FIELDS);
      if (!form || (Object.hasOwn(form, 'answer') && typeof form.answer !== 'string')) {
        return reject('invalid_form', questionId);
      }
      if (nonblank(form.answer)) text = form.answer;
    }
    if (choice === null && text === null) return reject('empty_answer', questionId);

    // This synchronous transition has no await point: one valid response wins.
    // Transport/callback retries never create a second accepted response.
    record.answer = { choice, text };
    record.answeredAt = now;
    return {
      accepted: true,
      code: 'accepted',
      questionId,
      answeredAt: now,
      answer: { ...record.answer },
    };
  }

  #view(record, now) {
    return {
      ...record,
      choices: [...record.choices],
      answer: record.answer === null ? null : { ...record.answer },
      status: record.answeredAt !== null
        ? 'answered'
        : now >= record.expiresAt ? 'expired' : 'pending',
    };
  }

  snapshot(questionId) {
    const now = this.#now();
    if (questionId !== undefined) {
      const record = this.#questions.get(questionId);
      return record ? this.#view(record, now) : null;
    }
    return [...this.#questions.values()].map((record) => this.#view(record, now));
  }
}