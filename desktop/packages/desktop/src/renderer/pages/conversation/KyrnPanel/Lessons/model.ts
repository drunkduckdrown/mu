import type { StoredLesson } from '@/common/kyrn/lessons';
import type { Activity } from '@/common/kyrn/types';

/** What the harness says about lessons: one stored, brought into a turn, followed, retired, merged into another. */
export const MEMORY_EVENTS: ReadonlySet<string> = new Set([
  'memory.stored',
  'memory.recalled',
  'memory.applied',
  'memory.retired',
  'memory.merged',
]);

/** A session's lesson events, oldest first: each one has the file read again, and is news while the tab is not seen. */
export const memoryEvents = (events: readonly Activity[]): Activity[] =>
  events.filter((event) => MEMORY_EVENTS.has(event.kind));

/** The lessons in use, or every lesson of the project. */
export type LessonFilter = 'active' | 'all';

/** More rows than this, and the tab offers a search. */
export const SEARCH_AFTER = 20;

const byUse = (a: StoredLesson, b: StoredLesson): number =>
  b.uses.applied - a.uses.applied || b.updated.localeCompare(a.updated);

/**
 * The rows of a filter: the lessons in use, the most followed first, then the latest written or confirmed, as recall
 * ranks them. `all` lists the retired and replaced ones after them, in the same order.
 */
export function shownLessons(lessons: readonly StoredLesson[], filter: LessonFilter): StoredLesson[] {
  const active = lessons.filter((lesson) => lesson.status === 'active').toSorted(byUse);
  if (filter === 'active') return active;
  return [...active, ...lessons.filter((lesson) => lesson.status !== 'active').toSorted(byUse)];
}

/** Whether every word searched for is in what the lesson says, when it applies, or the name of its kind. */
export function lessonMatches(lesson: StoredLesson, query: string, kindName: string): boolean {
  const text = `${lesson.lesson}\n${lesson.trigger}\n${kindName}`.toLocaleLowerCase();
  return query
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => text.includes(word));
}
