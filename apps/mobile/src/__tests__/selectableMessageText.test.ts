// Unit tier: the 「选择文字」 sheet copies what this returns, so code must come out exactly as shown.
import { describe, expect, it } from 'vitest';
import { selectableMessageText } from '@/session/selectableMessageText';

describe('selectableMessageText', () => {
  it('drops Markdown marks from prose', () => {
    expect(selectableMessageText('## Title\n- **bold** and [link](https://x.y)')).toBe('Title\n• bold and link');
  });

  it('keeps fenced and inline code verbatim', () => {
    const markdown = 'Run `print("**value**")` first.\n```python\n# important\nx = "**value**"\n```';
    expect(selectableMessageText(markdown)).toBe('Run print("**value**") first.\n# important\nx = "**value**"');
  });
});
