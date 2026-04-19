/**
 * Smart Reply suggestions — keyword heuristic, zero external API dependency.
 * Returns 3 contextually-relevant quick-reply options.
 */
export function getSmartReplies(lastMessage: string): string[] {
  const msg = lastMessage.toLowerCase().trim();

  // Greetings
  if (/\b(hi|hello|hey|hiya|howdy|sup|what'?s up)\b/.test(msg))
    return ['Hey! 👋', 'Hi there!', 'Hello! How are you?'];

  // How are you
  if (/how are you|how r u|how's it going|how do you do/.test(msg))
    return ["I'm good, thanks! 😊", 'Doing great! You?', 'Pretty good, and you?'];

  // Yes/no questions
  if (msg.endsWith('?')) {
    if (/\b(can you|could you|will you|would you|do you|are you|have you|did you)\b/.test(msg))
      return ['Yes, sure!', 'No, sorry 😅', 'Let me check 🤔'];
    return ['Yes! 👍', 'No 😕', 'Maybe, not sure'];
  }

  // Thanks
  if (/\b(thank|thanks|thx|ty|cheers)\b/.test(msg))
    return ["You're welcome! 😄", 'No problem!', 'Happy to help! 🙌'];

  // Sorry
  if (/\b(sorry|apologi|my bad|forgive)\b/.test(msg))
    return ["It's okay! 😊", "No worries!", "Don't worry about it"];

  // Good / Great
  if (/\b(good|great|nice|awesome|wonderful|fantastic|cool|excellent)\b/.test(msg))
    return ["That's great! 🎉", 'Awesome! 😍', 'Really? Tell me more!'];

  // Miss / miss you
  if (/miss (you|u)/.test(msg))
    return ['Miss you too! ❤️', 'Aww! 🥺', "Can't wait to talk more!"];

  // Love
  if (/\b(love|❤️|💕|💗)\b/.test(msg))
    return ['Love you too! ❤️', '💕', '😊 Means a lot!'];

  // Check-in
  if (/\b(busy|free|available|at work|sleeping|tired)\b/.test(msg))
    return ['Got it!', "I'll catch you later 😊", 'Take your time!'];

  // Default fallbacks
  return ['👍', 'Got it!', 'Sure!'];
}
