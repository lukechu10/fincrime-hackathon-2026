window.TIMELINE = {
 "duration": 115.055,
 "scenes": [
  {
   "id": "title",
   "start": 0,
   "duration": 11.704,
   "sentences": [
    {
     "text": "This is our Track 1 system.",
     "from": 0.9,
     "to": 2.274
    },
    {
     "text": "It plays the analyst: it reads each monitoring case and recommends close, request information, or escalate, citing the evidence it used.",
     "from": 2.724,
     "to": 10.604
    }
   ]
  },
  {
   "id": "run",
   "start": 11.704,
   "duration": 13.193,
   "sentences": [
    {
     "text": "One command takes an institution folder and writes one verdict per case.",
     "from": 0.9,
     "to": 4.303
    },
    {
     "text": "A thousand cases take about two seconds.",
     "from": 4.753,
     "to": 6.876
    },
    {
     "text": "Each line has a verdict, a reason code, a written reason and the evidence it cites.",
     "from": 7.326,
     "to": 12.093
    }
   ]
  },
  {
   "id": "pipeline",
   "start": 24.897,
   "duration": 21.326,
   "sentences": [
    {
     "text": "Every case takes four steps.",
     "from": 0.9,
     "to": 2.4
    },
    {
     "text": "Explain the transactions from documents and history.",
     "from": 2.85,
     "to": 5.305
    },
    {
     "text": "Look for concrete signs of suspicion.",
     "from": 5.755,
     "to": 7.51
    },
    {
     "text": "Test each alert against its own rule: it is covered only when what stays unexplained is below that rule's threshold.",
     "from": 7.96,
     "to": 13.619
    },
    {
     "text": "Then combine: suspicion escalates, a gap becomes one specific request, and otherwise the case closes.",
     "from": 14.069,
     "to": 20.226
    }
   ]
  },
  {
   "id": "case",
   "start": 46.223,
   "duration": 22.401,
   "sentences": [
    {
     "text": "Here is a held payment of £33,173.83 to Iraq.",
     "from": 0.9,
     "to": 3.71
    },
    {
     "text": "The invoice names the same supplier, the same amount to the penny, and the same account and reference, so the payment can be released.",
     "from": 4.16,
     "to": 10.926
    },
    {
     "text": "In a second case no invoice is on file, so the system asks for it.",
     "from": 11.376,
     "to": 15.066
    },
    {
     "text": "In a third, the invoice shows a different amount.",
     "from": 15.516,
     "to": 17.933
    },
    {
     "text": "That is a contradiction, so it goes to the MLRO.",
     "from": 18.383,
     "to": 21.301
    }
   ]
  },
  {
   "id": "decisions",
   "start": 68.624,
   "duration": 26.389,
   "sentences": [
    {
     "text": "Four decisions shaped the design.",
     "from": 0.9,
     "to": 2.312
    },
    {
     "text": "One: check facts, not wording. A wrongful close costs the most, so a close needs proof.",
     "from": 2.762,
     "to": 8.952
    },
    {
     "text": "Two: the decision logic is deterministic, and offline repeat runs are byte-identical.",
     "from": 9.402,
     "to": 14.196
    },
    {
     "text": "Three: one engine serves all four institutions; only policy settings differ.",
     "from": 14.646,
     "to": 19.191
    },
    {
     "text": "Four: fail safe. A case that cannot be read is escalated alone, and the run continues.",
     "from": 19.641,
     "to": 25.289
    }
   ]
  },
  {
   "id": "reader",
   "start": 95.013,
   "duration": 20.042,
   "sentences": [
    {
     "text": "If a key is supplied, a language model reads only documents no parser recognised.",
     "from": 0.9,
     "to": 5.371
    },
    {
     "text": "It is an untrusted reader: each fact needs a word-for-word quote, and the same rules still decide.",
     "from": 5.821,
     "to": 10.884
    },
    {
     "text": "Verdict, reason and evidence come from the same findings, so every answer traces to its source.",
     "from": 11.334,
     "to": 16.442
    }
   ]
  }
 ]
};
