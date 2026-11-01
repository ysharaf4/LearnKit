# LearnKit

A study and retention system integrated into Obsidian that turns notes into flashcards, reviews, and tests using adaptive spaced repetition.

## Language

**Study Session**:
An active study period that walks a student through a sequence of cards within a chosen scope.
_Avoid_: Review run, study queue, quiz loop

**Card**:
A discrete prompt and answer pair extracted from a note, scheduled for active recall.
_Avoid_: Flashcard item, note card, test unit

**Scope**:
The boundary within a vault (such as a folder, tag, note, or group) that determines which cards are eligible for study.
_Avoid_: Filter criteria, target set, collection filter

**Rating**:
The student's assessment of their recall ease for a card during a study session, driving scheduling updates.
_Avoid_: Grade value, score, answer grade

**Study Queue**:
The ordered sequence of cards remaining to be studied or reviewed during an active session.
_Avoid_: Card stack, study deck, review list

**Undo Frame**:
A snapshot of a single review transaction and its preceding scheduling state, allowing immediate rollback.
_Avoid_: Rollback token, grade history item

**Practice Session**:
A study session that presents cards for free recall without persisting scheduling mutations or review logs.
_Avoid_: Free mode, unrecorded run, drill mode

**Bury**:
Temporarily exclude a card or its siblings from study queues until the next day.
_Avoid_: Snooze, defer, hide

**Suspend**:
Remove a card from active review indefinitely until manually reactivated.
_Avoid_: Disable, archive, freeze

**Skip**:
Postpone a card to the end of the active study session without altering its scheduling interval.
_Avoid_: Pass, delay, postpone

**Anki Package**:
A self-contained archive (.apkg) containing an SQLite collection database and bundled media files, representing exported or imported flashcards and scheduling history.
_Avoid_: Anki zip, deck export archive, apkg bundle


