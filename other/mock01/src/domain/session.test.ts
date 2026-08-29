import { describe, expect, it } from 'vitest';

import {
  DEMO_GUIDE,
  createInitialSessionState,
  sessionReducer,
  type SessionEvent,
  type SessionState,
  type SessionStatus,
} from './session';

function dispatchAll(
  events: SessionEvent[],
  initial: SessionState = createInitialSessionState(),
): SessionState {
  return events.reduce(sessionReducer, initial);
}

describe('sessionReducer', () => {
  it('支援依頼からガイド保存までの正常系を通せる', () => {
    let state = createInitialSessionState();
    const visited: SessionStatus[] = [state.status];
    const send = (event: SessionEvent) => {
      state = sessionReducer(state, event);
      visited.push(state.status);
    };

    send({ type: 'OPEN_REQUEST_PANEL' });
    send({
      type: 'UPDATE_REQUEST_COMMENT',
      comment: '元の購入画面に戻れません',
    });
    send({
      type: 'SUBMIT_SUPPORT_REQUEST',
      createdAt: '2026-08-29T11:00:00+09:00',
    });

    expect(state.request).toMatchObject({
      comment: '元の購入画面に戻れません',
      createdAt: '2026-08-29T11:00:00+09:00',
    });

    send({ type: 'DELIVER_SUPPORT_REQUEST' });
    send({ type: 'VIEW_SUPPORT_REQUEST' });
    send({ type: 'START_CALL' });
    send({ type: 'ACCEPT_CALL' });
    send({ type: 'CONNECTION_ESTABLISHED' });
    send({ type: 'PLACE_MARKER', x: 0.24, y: 0.91 });

    expect(state.marker).toMatchObject({ x: 0.24, y: 0.91 });

    send({ type: 'END_SUPPORT' });
    expect(state.marker).toBeNull();
    send({ type: 'CHOOSE_CREATE_GUIDE' });

    expect(state.guide).toEqual({
      title: DEMO_GUIDE.title,
      steps: [...DEMO_GUIDE.steps],
    });

    send({ type: 'UPDATE_GUIDE_TITLE', title: '元の画面へ戻る方法' });
    send({
      type: 'UPDATE_GUIDE_STEP',
      index: 1,
      text: 'タスクバーの飛行機アイコンを押します。',
    });
    send({ type: 'BEGIN_GUIDE_REVIEW' });
    send({ type: 'SAVE_GUIDE' });

    expect(state.status).toBe('completed');
    expect(state.guide?.title).toBe('元の画面へ戻る方法');
    expect(state.guide?.steps[1]).toBe(
      'タスクバーの飛行機アイコンを押します。',
    );
    expect(visited).toEqual(
      expect.arrayContaining([
        'idle',
        'requestDraft',
        'requestSent',
        'waitingForFamily',
        'familyViewingRequest',
        'incomingCall',
        'connecting',
        'inSession',
        'guideDecision',
        'guideDraft',
        'guideReview',
        'completed',
      ] satisfies SessionStatus[]),
    );
  });

  it('ガイドを作らない分岐で支援を終了できる', () => {
    const state = dispatchAll([
      { type: 'OPEN_REQUEST_PANEL' },
      { type: 'SUBMIT_SUPPORT_REQUEST' },
      { type: 'DELIVER_SUPPORT_REQUEST' },
      { type: 'VIEW_SUPPORT_REQUEST' },
      { type: 'START_CALL' },
      { type: 'ACCEPT_CALL' },
      { type: 'CONNECTION_ESTABLISHED' },
      { type: 'END_SUPPORT' },
      { type: 'CHOOSE_SKIP_GUIDE' },
    ]);

    expect(state.status).toBe('completed');
    expect(state.guide).toBeNull();
  });

  it('現在状態で許可されないイベントでは状態を変えない', () => {
    const initial = createInitialSessionState();
    expect(sessionReducer(initial, { type: 'START_CALL' })).toBe(initial);

    const inSession = dispatchAll([
      { type: 'OPEN_REQUEST_PANEL' },
      { type: 'SUBMIT_SUPPORT_REQUEST' },
      { type: 'DELIVER_SUPPORT_REQUEST' },
      { type: 'VIEW_SUPPORT_REQUEST' },
      { type: 'START_CALL' },
      { type: 'ACCEPT_CALL' },
      { type: 'CONNECTION_ESTABLISHED' },
    ]);
    expect(
      sessionReducer(inSession, {
        type: 'PLACE_MARKER',
        x: 1.2,
        y: 0.5,
      }),
    ).toBe(inSession);

    const guideDraft = dispatchAll(
      [
        { type: 'END_SUPPORT' },
        { type: 'CHOOSE_CREATE_GUIDE' },
      ],
      inSession,
    );
    expect(sessionReducer(guideDraft, { type: 'SAVE_GUIDE' })).toBe(
      guideDraft,
    );
    expect(
      sessionReducer(guideDraft, {
        type: 'UPDATE_GUIDE_STEP',
        index: 99,
        text: '存在しない手順',
      }),
    ).toBe(guideDraft);
  });

  it('リセットすると内容を初期化し、リセットイベントだけを残す', () => {
    const completed = dispatchAll([
      { type: 'OPEN_REQUEST_PANEL' },
      { type: 'SUBMIT_SUPPORT_REQUEST' },
      { type: 'DELIVER_SUPPORT_REQUEST' },
      { type: 'VIEW_SUPPORT_REQUEST' },
      { type: 'START_CALL' },
      { type: 'ACCEPT_CALL' },
      { type: 'CONNECTION_ESTABLISHED' },
      { type: 'END_SUPPORT' },
      { type: 'CHOOSE_SKIP_GUIDE' },
    ]);

    expect(sessionReducer(completed, { type: 'RESET_DEMO' })).toEqual({
      ...createInitialSessionState(),
      lastEvent: 'RESET_DEMO',
      eventLog: ['RESET_DEMO'],
    });
  });
});
