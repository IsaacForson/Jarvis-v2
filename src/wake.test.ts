import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isEndMeeting, isForgetVoiceCommand, isStartDictation, isStartMeeting, isStopDictation, isLearnVoiceCommand, isSleepCommand, parseHandover, parseWake, parseYesNo } from './wake.ts';

test('a name at the start says who is addressed, with or without a greeting', () => {
  assert.deepEqual(parseWake('Hey Jarvis.'), { name: 'jarvis', rest: '' });
  assert.deepEqual(parseWake('Jarvis, what time is it?'), { name: 'jarvis', rest: 'what time is it?' });
  assert.deepEqual(parseWake(' okay, Javis! Are you there?'), { name: 'jarvis', rest: 'Are you there?' });
  assert.deepEqual(parseWake('Friday, are you there?'), { name: 'friday', rest: 'are you there?' });
  assert.deepEqual(parseWake('Hey Friday'), { name: 'friday', rest: '' });
  assert.deepEqual(parseWake('Javis, javis.'), { name: 'jarvis', rest: '' });
  assert.deepEqual(parseWake('Um, okay, Jarvis, open Safari.'), { name: 'jarvis', rest: 'open Safari.' });
});

test('a name starting a sentence after other talk counts, a name mentioned in passing does not', () => {
  assert.deepEqual(parseWake('I love his music, his melodies are phenomenal. Um, okay. Jarvis, what time is it?'), { name: 'jarvis', rest: 'what time is it?' });
  assert.deepEqual(parseWake('That was a great game. Friday, turn it off.'), { name: 'friday', rest: 'turn it off.' });
  assert.deepEqual(parseWake('We met last week. Friday is the deadline.'), { rest: 'We met last week. Friday is the deadline.' });
});

test('the name as whisper spells it for some accents still wakes Jarvis, at the start only', () => {
  assert.deepEqual(parseWake('Charvis, what time is it?'), { name: 'jarvis', rest: 'what time is it?' });
  assert.deepEqual(parseWake('Jarbis.'), { name: 'jarvis', rest: '' });
  assert.deepEqual(parseWake('Hey, Jav is, open Safari.'), { name: 'jarvis', rest: 'open Safari.' });
  assert.deepEqual(parseWake("Jarvis's, are you there?"), { name: 'jarvis', rest: 'are you there?' });
  for (const text of ['Davies said no.', 'Service was slow.', 'I met Charvis yesterday.', 'Java is great.']) assert.deepEqual(parseWake(text), { rest: text }, text);
});

test('a name at the end, after a comma, counts too', () => {
  assert.deepEqual(parseWake('What time is it, Jarvis?'), { name: 'jarvis', rest: 'What time is it?' });
  assert.deepEqual(parseWake('Open Safari, Friday.'), { name: 'friday', rest: 'Open Safari.' });
});

test('speech that is not addressed to either is left as it is', () => {
  for (const text of ['What time is it?', 'I told him about Jarvis yesterday.', 'Hey Jarvison', 'See you on Friday.', '']) {
    assert.deepEqual(parseWake(text), { rest: text }, text);
  }
});

test('short dismissals are sleep commands', () => {
  for (const text of ['Go to sleep.', 'Stop listening.', 'Goodnight', "That's all.", 'go quiet']) {
    assert.equal(isSleepCommand(text), true, text);
  }
});

test('ordinary sentences that mention sleep are not', () => {
  for (const text of ['I want to go to sleep early tonight, remind me.', 'How do I sleep better?', 'Listen to this.']) {
    assert.equal(isSleepCommand(text), false, text);
  }
});

test('voice-lock commands are recognised, and long sentences about voices are not', () => {
  assert.equal(isLearnVoiceCommand('Learn my voice.'), true);
  assert.equal(isLearnVoiceCommand('Please remember my voice'), true);
  assert.equal(isForgetVoiceCommand('Forget my voice.'), true);
  assert.equal(isLearnVoiceCommand('Forget my voice.'), false);
  assert.equal(isLearnVoiceCommand('Do you think a computer could ever learn to copy my voice exactly?'), false);
});

test('a request for the other assistant is a hand-over', () => {
  for (const text of ['I want to talk to Friday.', 'Let me speak with Friday', 'Switch to Friday.', 'Hand over to Friday', 'Get me Friday.', 'Friday, take over.']) {
    assert.equal(parseHandover(text), 'friday', text);
  }
  assert.equal(parseHandover('Can I talk to Jarvis?'), 'jarvis');
  assert.equal(parseHandover('Bring back Javis.'), 'jarvis');
});

test('mentioning a name in passing is not a hand-over', () => {
  for (const text of ['What is on Friday?', 'I talked to my boss about Jarvis.', 'Remind me to get the report ready so that I can talk to Friday about the budget next week.']) {
    assert.equal(parseHandover(text), undefined, text);
  }
});

test('yes-or-no answers are understood, with "no" winning when both are said', () => {
  for (const text of ['Yes.', 'Yeah, go ahead.', 'Sure, do it', 'Okay.', 'Please do.']) assert.equal(parseYesNo(text), true, text);
  for (const text of ['No.', "Don't.", 'Cancel that', 'Never mind.', 'No, okay, leave it.', 'Yes... no, stop.']) assert.equal(parseYesNo(text), false, text);
  for (const text of ['What was that?', 'Maybe later', '']) assert.equal(parseYesNo(text), undefined, text);
});

test('dictation and meeting-notes commands are recognised, and passing mentions are not', () => {
  for (const said of ['Start dictation.', 'Type what I say.', 'Type this', 'Dictation mode.', 'Please take dictation']) assert.equal(isStartDictation(said), true, said);
  for (const said of ['What is dictation?', 'Type the address into Safari and press return and then read the page to me']) assert.equal(isStartDictation(said), false, said);
  for (const said of ['Stop dictation.', 'Stop typing', 'End the dictation', 'Dictation off.']) assert.equal(isStopDictation(said), true, said);
  assert.equal(isStopDictation('We should stop for lunch.'), false);
  for (const said of ['Take notes of this meeting.', 'Start taking notes', 'Take meeting notes.', 'Start the meeting.', 'Take minutes']) assert.equal(isStartMeeting(said), true, said);
  assert.equal(isStartMeeting('Did you take my notes off the desk?'), false);
  assert.equal(isStartMeeting('What meetings do I have today?'), false);
  for (const said of ['End the meeting.', 'Stop taking notes', 'The meeting is over.', 'Finish the notes']) assert.equal(isEndMeeting(said), true, said);
  assert.equal(isEndMeeting('When does the meeting end?'), false);
});
