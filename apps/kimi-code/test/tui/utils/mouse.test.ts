import { describe, expect, it, mock } from 'bun:test';

import type { TuiMouseEvent } from '@moonshot-ai/pi-tui';

import {
  DialogMouse,
  ListMouseRouter,
  mouseDispatch,
  regionAt,
  ScrollMouseRouter,
  translateMouse,
  type ListCursor,
  type ListRowRegion,
} from '#/tui/utils/mouse';

function mouse(type: TuiMouseEvent['type'], y = 0, wheelDelta?: number, x = 4): TuiMouseEvent {
  return {
    type,
    button: type === 'move' || type === 'wheel' ? 'none' : 'left',
    x,
    y,
    screenX: x,
    screenY: y,
    width: 80,
    height: 30,
    shift: false,
    alt: false,
    ctrl: false,
    wheelDelta,
  };
}

/** A cursor over a fixed set of three items, one page. */
function cursor(overrides: Partial<ListCursor<string>> = {}): ListCursor<string> {
  let index = 0;
  return {
    items: () => ['a', 'b', 'c'],
    selectedIndex: () => index,
    pageCount: () => 1,
    moveTo: (next) => {
      index = next;
    },
    page: () => {},
    ...overrides,
  };
}

function rows(): ListRowRegion[] {
  return [
    { start: 2, end: 3, index: 0 },
    { start: 3, end: 4, index: 1 },
    { start: 4, end: 5, index: 2 },
  ];
}

describe('DialogMouse', () => {
  it('leaves the event to the panel once it holds the keyboard', () => {
    expect(new DialogMouse(() => true).handoff(mouse('press'))).toBeUndefined();
  });

  it('swallows the first press and hands over the keyboard on the first click', () => {
    const focused = new DialogMouse(() => false);
    expect(focused.handoff(mouse('press'))).toEqual({ handled: true });
    expect(focused.handoff(mouse('click'))).toEqual({ handled: true, focus: true });
    expect(focused.handoff(mouse('move'))).toBeUndefined();
  });

  it('reads a notch as a direction and nothing else as a turn', () => {
    const focused = new DialogMouse(() => true);
    expect(focused.wheel(mouse('wheel', 0, -1))).toBe(-1);
    expect(focused.wheel(mouse('wheel', 0, 1))).toBe(1);
    expect(focused.wheel(mouse('wheel', 0, 0))).toBe(1);
    expect(focused.wheel(mouse('press'))).toBe(0);
    expect(focused.wheel(mouse('wheel'))).toBe(0);
  });

  it('treats a click right after appearing as settling, and a later one as deliberate', () => {
    expect(new DialogMouse(() => true, Date.now()).settling(mouse('click'))).toBe(true);
    expect(new DialogMouse(() => true, Date.now() - 5_000).settling(mouse('click'))).toBe(false);
    // A press is never a commitment, so the window does not apply to it.
    expect(new DialogMouse(() => true, Date.now()).settling(mouse('press'))).toBe(false);
  });
});

describe('regionAt', () => {
  it('matches the row and, when declared, the column span', () => {
    const left = [{ start: 1, end: 2, columnStart: 2, columnEnd: 10, index: 7 }];
    expect(regionAt(left, { x: 5, y: 1 })?.index).toBe(7);
    expect(regionAt(left, { x: 1, y: 1 })).toBeUndefined();
    expect(regionAt(left, { x: 10, y: 1 })).toBeUndefined();
    expect(regionAt(left, { x: 5, y: 2 })).toBeUndefined();
  });
});

describe('ListMouseRouter', () => {
  it('highlights the row under the pointer without picking it', () => {
    const pick = mock();
    const router = new ListMouseRouter(cursor(), pick);
    router.setRegions(rows());

    const result = router.handleMouse(mouse('move', 3));

    expect(result).toEqual({ handled: true, render: true });
    expect(pick).not.toHaveBeenCalled();
  });

  it('picks the clicked row, and only for a left button', () => {
    const pick = mock();
    const router = new ListMouseRouter(cursor(), pick, { shownAt: Date.now() - 5_000 });
    router.setRegions(rows());

    expect(router.handleMouse({ ...mouse('click', 4), button: 'right' })).toBeUndefined();
    expect(pick).not.toHaveBeenCalled();

    router.handleMouse(mouse('click', 4));
    expect(pick).toHaveBeenCalledWith('c');
  });

  it('selects on press so a drag started on a row has a cursor to follow', () => {
    const pick = mock();
    const target = cursor();
    const router = new ListMouseRouter(target, pick);
    router.setRegions(rows());

    expect(router.handleMouse(mouse('press', 3))).toEqual({ handled: true, render: true });
    expect(target.selectedIndex()).toBe(1);
    expect(pick).not.toHaveBeenCalled();
  });

  it('turns pages with the wheel but does not page a single-page list', () => {
    const page = mock();
    const paged = new ListMouseRouter(cursor({ pageCount: () => 2, page }), mock());
    expect(paged.handleMouse(mouse('wheel', 0, 1))).toEqual({ handled: true, render: false });
    expect(page).toHaveBeenCalledWith(1);

    const single = new ListMouseRouter(cursor({ pageCount: () => 1, page }), mock());
    expect(single.handleMouse(mouse('wheel', 0, 1))).toEqual({ handled: true });
    expect(page).toHaveBeenCalledTimes(1);
  });

  it('ignores a click that lands inside the settling window but still moves the cursor', () => {
    const pick = mock();
    const router = new ListMouseRouter(cursor(), pick);
    router.setRegions(rows());

    router.handleMouse(mouse('press', 2));
    expect(router.handleMouse(mouse('click', 2))).toEqual({ handled: true });
    expect(pick).not.toHaveBeenCalled();
  });

  it('takes the keyboard before acting, once', () => {
    const pick = mock();
    const router = new ListMouseRouter(cursor(), pick, { isFocused: () => false });
    router.setRegions(rows());

    expect(router.handleMouse(mouse('click', 3))).toEqual({ handled: true, focus: true });
    expect(pick).not.toHaveBeenCalled();
  });
});

describe('ScrollMouseRouter', () => {
  it('scrolls on a wheel notch and leaves every other event alone', () => {
    const scroll = mock((_direction: -1 | 1, _delta: number) => true);
    const router = new ScrollMouseRouter(scroll);

    expect(router.handleMouse(mouse('wheel', 0, 1))).toEqual({ handled: true, render: true });
    expect(scroll).toHaveBeenCalledWith(1, 1);
    expect(router.handleMouse(mouse('click'))).toBeUndefined();
  });

  it('asks for no repaint when the view did not move', () => {
    const router = new ScrollMouseRouter(() => false);
    expect(router.handleMouse(mouse('wheel', 0, 1))).toEqual({ handled: true, render: false });
  });

  it('passes the raw delta so a panel can scroll as far as the wheel turned', () => {
    const scroll = mock((_direction: -1 | 1, _delta: number) => true);
    const router = new ScrollMouseRouter(scroll);

    router.handleMouse(mouse('wheel', 0, 3));

    expect(scroll).toHaveBeenCalledWith(1, 3);
  });

  it('consumes a notch that moved nothing when the panel owns the wheel', () => {
    const router = new ScrollMouseRouter(() => false, true);
    expect(router.handleMouse(mouse('wheel', 0, 1))).toEqual({ handled: true });
  });

  it('leaves an empty notch to whatever scrolls behind the panel', () => {
    expect(new ScrollMouseRouter(mock()).handleMouse(mouse('wheel', 0, 0))).toBeUndefined();
  });
});

describe('translateMouse', () => {
  it('shifts local coordinates and leaves the screen point alone', () => {
    const event = mouse('click', 5, undefined, 9);
    const local = translateMouse(event, -3, -2);
    expect(local).toMatchObject({ x: 6, y: 3, screenX: 9, screenY: 5 });
    expect(event).toMatchObject({ x: 9, y: 5 });
  });
});

describe('mouseDispatch', () => {
  it('passes an unanswered event through', () => {
    const component = { render: () => [], invalidate: () => {} };
    expect(mouseDispatch(component, mouse('press'), undefined)).toBeUndefined();
  });

  it('marks the answer handled and records how coordinates map back', () => {
    const component = { render: () => [], invalidate: () => {} };
    const event = { ...mouse('click', 3, undefined, 5), screenX: 20, screenY: 40 };

    expect(mouseDispatch(component, event, { focus: true })).toEqual({
      handled: true,
      focus: true,
      target: { component, originX: 15, originY: 37, width: 80, height: 30 },
    });
  });
});
