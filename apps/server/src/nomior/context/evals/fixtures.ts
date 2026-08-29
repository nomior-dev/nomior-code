/**
 * fixtures - the synthetic golden-set corpus for retrieval evals.
 *
 * A small bilingual (EN/RU) mix of meetings, documents, emails and memories,
 * mostly in one project scope plus one source in a second project to keep the
 * isolation question honest. Content is written so each golden question has a
 * clearly correct source — the corpus is the contract, do not casually reword
 * it without re-checking golden.ts.
 *
 * @module fixtures
 */
import type { NomiorScope, SourceInput } from "../Model.ts";

export const EVAL_PROJECT: NomiorScope = { kind: "project", value: "eval-nomior" };
export const EVAL_OTHER_PROJECT: NomiorScope = { kind: "project", value: "eval-other" };

export const evalCorpus: ReadonlyArray<SourceInput> = [
  {
    kind: "meeting",
    externalId: "eval-launch-meeting",
    title: "Launch planning sync",
    occurredAt: "2026-08-12T10:00:00.000Z",
    scopes: [EVAL_PROJECT],
    segments: [
      {
        text: "We agreed to move the public launch to the last week of September.",
        speaker: "Ivan",
        tsStart: 30,
        tsEnd: 42,
      },
      {
        text: "Marketing needs the demo GIFs re-recorded before the launch announcement goes out.",
        speaker: "Dasha",
        tsStart: 42,
        tsEnd: 60,
      },
      {
        text: "The installer must ship with database snapshot rollback enabled by default.",
        speaker: "Ivan",
        tsStart: 60,
        tsEnd: 78,
      },
    ],
    decisions: [
      {
        statement: "Public launch moves to the last week of September",
        decidedAt: "2026-08-12T10:00:00.000Z",
        evidence: { charStart: 0, charEnd: 60 },
      },
    ],
  },
  {
    kind: "document",
    externalId: "eval-broker-design",
    title: "Context broker design note",
    occurredAt: "2026-08-01T00:00:00.000Z",
    scopes: [EVAL_PROJECT],
    segments: [
      {
        text: "Retrieval fuses BM25 over FTS5 with dense cosine similarity using reciprocal rank fusion at k equals sixty.",
        section: "Retrieval",
      },
      {
        text: "Every snippet carries an evidence span: character offsets into the canonical source text.",
        section: "Evidence",
      },
      {
        text: "The token budget is enforced server side; truncated responses tell the agent to narrow the query.",
        section: "Budget",
      },
    ],
  },
  {
    kind: "email",
    externalId: "eval-granola-email",
    title: "Granola connector API terms",
    occurredAt: "2026-08-20T09:00:00.000Z",
    scopes: [EVAL_PROJECT],
    segments: [
      {
        text: "Granola support confirmed that commercial use of their local cache is allowed for personal tooling, but redistribution of their API requires a partnership agreement.",
        speaker: "support@granola.ai",
      },
      {
        text: "Action for us: verify the partnership terms before the public release milestone.",
        speaker: "Ivan",
      },
    ],
  },
  {
    kind: "meeting",
    externalId: "eval-anarlog-meeting",
    title: "Планёрка по интеграции Anarlog",
    occurredAt: "2026-08-18T14:00:00.000Z",
    scopes: [EVAL_PROJECT],
    segments: [
      {
        text: "Коннектор читает локальную базу SQLite и markdown экспорт, ничего не реверс-инжинирим.",
        speaker: "Иван",
        tsStart: 10,
        tsEnd: 25,
      },
      {
        text: "Диаризацию берём из pyannote, у Sortformer жёсткий лимит на четырёх спикеров.",
        speaker: "Олег",
        tsStart: 25,
        tsEnd: 40,
      },
      {
        text: "Если схема их базы поменяется, коннектор переключается на markdown экспорт и показывает статус ожидания обновления.",
        speaker: "Иван",
        tsStart: 40,
        tsEnd: 58,
      },
    ],
  },
  {
    kind: "document",
    externalId: "eval-pricing-doc",
    title: "Заметки по ценообразованию",
    occurredAt: "2026-08-25T00:00:00.000Z",
    scopes: [EVAL_PROJECT],
    segments: [
      {
        text: "Всё локальное бесплатно, всё серверное платно: это история доверия и одновременно защита от нарушения условий провайдеров.",
        section: "Принцип",
      },
      {
        text: "Тариф Pro около пятнадцати долларов в месяц: облачная синхронизация, удалённый доступ и короткие ссылки.",
        section: "Pro",
      },
      {
        text: "Командный тариф добавляет общую память организации и ревью на ключах компании.",
        section: "Team",
      },
    ],
  },
  {
    kind: "memory",
    externalId: "eval-embedding-memory",
    title: "Решение по embedding-модели",
    occurredAt: "2026-08-29T00:00:00.000Z",
    scopes: [EVAL_PROJECT],
    segments: [
      {
        text: "По умолчанию используем EmbeddingGemma-300M: мультиязычная, меньше пятисот мегабайт, работает на устройстве. BGE-M3 остаётся опцией повышенного качества.",
      },
    ],
  },
  {
    kind: "session",
    externalId: "eval-review-session",
    title: "Review pipeline debugging session",
    occurredAt: "2026-08-27T16:00:00.000Z",
    scopes: [EVAL_PROJECT],
    segments: [
      {
        text: "The review verdict gate failed because the CI intake step saw a pending check and refused to start a blind review.",
        speaker: "agent",
      },
      {
        text: "Fixed by waiting for the checks to settle before dispatching reviewer legs; the label is consumed exactly once per round.",
        speaker: "agent",
      },
    ],
  },
  {
    kind: "meeting",
    externalId: "eval-other-project-meeting",
    title: "Other project weekly",
    occurredAt: "2026-08-15T11:00:00.000Z",
    scopes: [EVAL_OTHER_PROJECT],
    segments: [
      {
        text: "The other project also discussed its launch date and decided on October instead.",
        speaker: "Mark",
      },
    ],
  },
];
