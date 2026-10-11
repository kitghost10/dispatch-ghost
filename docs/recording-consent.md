# Call recording consent

- Each tenant has `recording.enabled` and `recording.preamble` in Settings. When recording is on, Twilio `<Say>`s the preamble **before** the AI connects (`connectStreamTwiml`). Recording starts over the REST API once the media stream starts, and transfers are recorded with `record-from-answer-dual`.
- Default preamble: "This call may be recorded for quality and training purposes."
- Two-party (all-party) consent states include California, Florida, Illinois, Maryland, Massachusetts, Montana, New Hampshire, Pennsylvania, and Washington. Callers can be anywhere, so keep the preamble on for every tenant unless their counsel says otherwise. Staying on the line after the notice is the usual form of consent.
- The AI always discloses that it is a virtual assistant in the greeting. The greeting is set in code and is not tenant-editable.
- Transcripts are stored per tenant under row-level security. Set a retention policy per client contract; a `DELETE … WHERE started_at < now() - interval '…'` cron is the simplest approach and is not included yet.
- This is not legal advice. Have each plumbing client confirm the preamble wording for their states.
