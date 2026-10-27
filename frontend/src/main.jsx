import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Activity, AudioLines, Check, ChevronRight, Clock3, FileAudio, Languages, LoaderCircle, Mic, MicOff, Pencil, Plus, Search, Trash2, X } from 'lucide-react';
import './styles.css';

const API = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000').replace(/\/$/, '');
const WS = API.replace(/^http/, 'ws') + '/ws/transcribe';

async function request(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try { const body = await response.json(); message = body.detail || message; } catch {}
    throw new Error(message);
  }
  if (response.status === 204) return null;
  return response.json();
}

function toPcm16Base64(float32, inputRate) {
  const targetRate = 16000;
  const ratio = inputRate / targetRate;
  const outLength = Math.floor(float32.length / ratio);
  const pcm = new Int16Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), float32.length);
    let sum = 0;
    for (let j = start; j < end; j++) sum += float32[j];
    const sample = sum / Math.max(1, end - start);
    pcm[i] = Math.max(-1, Math.min(1, sample)) * (sample < 0 ? 32768 : 32767);
  }
  const bytes = new Uint8Array(pcm.buffer);
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + step, bytes.length)));
  }
  return btoa(binary);
}

function App() {
  const [history, setHistory] = useState([]);
  const [search, setSearch] = useState('');
  const [transcript, setTranscript] = useState('');
  const [interim, setInterim] = useState('');
  const [title, setTitle] = useState('Untitled transcription');
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null);
  const [editTitle, setEditTitle] = useState('');
  const [editText, setEditText] = useState('');
  const [selected, setSelected] = useState(null);
  const socketRef = useRef(null);
  const audioContextRef = useRef(null);
  const processorRef = useRef(null);
  const streamRef = useRef(null);
  const transcriptRef = useRef('');
  const statusRef = useRef('idle');

  const refreshHistory = useCallback(async (query = search) => {
    try {
      const data = await request(`/api/transcriptions${query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ''}`);
      setHistory(data);
    } catch (e) { setError(`Could not load history: ${e.message}`); }
  }, [search]);

  useEffect(() => { refreshHistory(''); }, []); // initial load
  useEffect(() => {
    const id = setTimeout(() => refreshHistory(search), 250);
    return () => clearTimeout(id);
  }, [search, refreshHistory]);

  const cleanupAudio = useCallback(async () => {
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current.onaudioprocess = null;
      processorRef.current = null;
    }
    if (audioContextRef.current) {
      await audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
  }, []);

  const stopRecording = useCallback(async () => {
    statusRef.current = 'saving';
    setStatus('saving');
    try {
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({ type: 'stop' }));
        await new Promise(resolve => setTimeout(resolve, 500));
        socketRef.current.close();
      }
    } catch {}
    socketRef.current = null;
    await cleanupAudio();
    const finalText = transcriptRef.current.trim();
    if (finalText) {
      try {
        await request('/api/transcriptions', {
          method: 'POST',
          body: JSON.stringify({ title: title.trim() || 'Untitled transcription', transcript: finalText, language: 'Auto-detected / multilingual' }),
        });
        await refreshHistory('');
        setError('');
      } catch (e) { setError(`Transcript captured but could not be saved: ${e.message}`); }
    }
    statusRef.current = 'idle';
    setStatus('idle');
  }, [cleanupAudio, refreshHistory, title]);

  const startRecording = async () => {
    setError(''); setTranscript(''); transcriptRef.current = ''; setInterim('');
    try {
      if (!import.meta.env.VITE_API_BASE_URL && location.hostname !== 'localhost') {
        throw new Error('Set VITE_API_BASE_URL to your deployed FastAPI URL and rebuild the frontend.');
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      streamRef.current = stream;
      const context = new AudioContext();
      audioContextRef.current = context;
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;
      setStatus('connecting');
      statusRef.current = 'connecting';
      const socket = new WebSocket(WS);
      socketRef.current = socket;
      socket.onmessage = event => {
        const message = JSON.parse(event.data);
        if (message.type === 'error') { setError(message.message); return; }
        if (message.type === 'ready') { statusRef.current = 'recording'; setStatus('recording'); }
        if (message.type === 'interim') setInterim(message.text || '');
        if (message.type === 'final' && message.text) {
          const next = `${transcriptRef.current}${transcriptRef.current ? ' ' : ''}${message.text}`;
          transcriptRef.current = next;
          setTranscript(next);
          setInterim('');
        }
      };
      socket.onerror = () => setError('WebSocket connection failed. Check the backend URL and Gemini API key.');
      socket.onclose = () => {
        if (statusRef.current === 'recording') {
          statusRef.current = 'idle'; setStatus('idle');
        }
      };
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timed out connecting to speech service.')), 12000);
        socket.onopen = () => { clearTimeout(timeout); resolve(); };
        socket.onclose = () => { clearTimeout(timeout); reject(new Error('Could not connect to the transcription service.')); };
      });
      processor.onaudioprocess = event => {
        if (socket.readyState !== WebSocket.OPEN || statusRef.current !== 'recording') return;
        const pcmBase64 = toPcm16Base64(event.inputBuffer.getChannelData(0), context.sampleRate);
        socket.send(JSON.stringify({ type: 'audio', data: pcmBase64 }));
      };
      source.connect(processor);
      // Connect through a zero-gain node so the processor runs without feedback.
      const silent = context.createGain(); silent.gain.value = 0;
      processor.connect(silent); silent.connect(context.destination);
    } catch (e) {
      setError(e.message || 'Could not start microphone. Check browser permissions.');
      await cleanupAudio();
      socketRef.current?.close(); socketRef.current = null;
      statusRef.current = 'idle'; setStatus('idle');
    }
  };

  const saveManual = async () => {
    if (!transcript.trim()) return setError('Record speech or type a transcript before saving.');
    try {
      await request('/api/transcriptions', { method: 'POST', body: JSON.stringify({ title: title.trim() || 'Untitled transcription', transcript: transcript.trim(), language: 'Auto-detected / multilingual' }) });
      setError(''); await refreshHistory('');
    } catch (e) { setError(e.message); }
  };

  const openEdit = item => { setEditing(item.id); setEditTitle(item.title); setEditText(item.transcript); };
  const saveEdit = async () => {
    try {
      await request(`/api/transcriptions/${editing}`, { method: 'PUT', body: JSON.stringify({ title: editTitle, transcript: editText }) });
      setEditing(null); await refreshHistory(''); setError('');
      if (selected?.id === editing) setSelected({ ...selected, title: editTitle, transcript: editText });
    } catch (e) { setError(e.message); }
  };
  const deleteItem = async id => {
    if (!window.confirm('Delete this transcription permanently?')) return;
    try { await request(`/api/transcriptions/${id}`, { method: 'DELETE' }); if (selected?.id === id) setSelected(null); await refreshHistory(''); }
    catch (e) { setError(e.message); }
  };

  const recording = ['connecting', 'recording'].includes(status);
  const displayedTranscript = [transcript, interim].filter(Boolean).join(transcript && interim ? ' ' : '');
  const wordCount = transcript.trim() ? transcript.trim().split(/\s+/).length : 0;

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><AudioLines size={22}/></div><div><strong>VoxNote</strong><span>Speech workspace</span></div></div>
      <div className="nav-label">WORKSPACE</div>
      <div className="nav-item active"><Activity size={17}/> Transcription studio</div>
      <div className="nav-item"><Clock3 size={17}/> History <span className="nav-count">{history.length}</span></div>
      <div className="sidebar-bottom"><div className="live-dot"/> <span>Speech workspace</span><span className="version">MVP</span></div>
    </aside>

    <main className="main-content">
      <header className="topbar"><div><div className="eyebrow">AI SPEECH WORKSPACE</div><h1>Transcription studio</h1><p>Turn spoken words into text, in real time.</p></div><div className="top-pill"><span className="live-dot"/> Multilingual mode</div></header>
      {error && <div className="error-banner"><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss"><X size={16}/></button></div>}

      <section className="studio-grid">
        <div className="panel capture-panel">
          <div className="panel-heading"><div><span className="section-kicker">LIVE CAPTURE</span><h2>Speak naturally</h2></div><span className={`status-chip ${status}`}>{status === 'recording' ? '● Recording' : status === 'connecting' ? 'Connecting…' : status === 'saving' ? 'Saving…' : 'Ready'}</span></div>
          <label className="field-label" htmlFor="transcription-title">Session title</label>
          <input id="transcription-title" className="title-input" value={title} onChange={e => setTitle(e.target.value)} maxLength={200} placeholder="e.g. Meeting notes" disabled={recording || status === 'saving'}/>
          <div className={`transcript-area ${recording ? 'is-live' : ''}`}>
            <div className="transcript-meta"><span><span className="live-dot"/> LIVE TRANSCRIPT</span><span><Languages size={14}/> Auto language detection</span></div>
            {displayedTranscript ? <p className="transcript-text">{transcript}{interim && <span className="interim-text">{transcript ? ' ' : ''}{interim}</span>}</p> : <div className="empty-transcript"><div className="sound-orb"><AudioLines size={28}/></div><strong>Your words will appear here</strong><span>Press the microphone and start speaking in English, Hindi, or a mix of languages.</span></div>}
            {recording && <div className="listening"><span className="pulse-dot"/> Listening for speech…</div>}
          </div>
          <div className="capture-footer"><div className="stats"><span><FileAudio size={15}/> {wordCount} words</span><span><Clock3 size={15}/> {status === 'recording' ? 'Live session' : 'Ready to record'}</span></div>
            {!recording ? <button className="primary-button" onClick={startRecording} disabled={status === 'saving'}><Mic size={18}/> {status === 'connecting' ? 'Connecting…' : 'Start recording'}</button> : <button className="stop-button" onClick={stopRecording}><MicOff size={18}/> Stop & save</button>}
          </div>
          {!recording && transcript.trim() && <div className="manual-save"><button className="text-button" onClick={saveManual}><Plus size={15}/> Save current text as new record</button><button className="text-button" onClick={() => { setTranscript(''); transcriptRef.current = ''; setInterim(''); }}><X size={15}/> Clear</button></div>}
          <p className="privacy-note">Microphone audio is streamed to the configured speech provider. Finalized text is saved only when you stop recording.</p>
        </div>

        <div className="side-stack">
          <div className="panel tip-panel"><div className="tip-icon"><Languages size={20}/></div><span className="section-kicker">LANGUAGE SUPPORT</span><h3>Speak your way</h3><p>Automatic language detection is enabled. Try a natural sentence such as:</p><div className="example-quote">“Today ka meeting at 3 PM hai, please remind me.”</div><div className="language-tags"><span>English</span><span>हिन्दी</span><span>Hinglish</span></div></div>
          <div className="panel summary-panel"><span className="section-kicker">YOUR WORKSPACE</span><div className="summary-number">{history.length.toString().padStart(2, '0')}</div><p>Saved transcriptions</p><div className="summary-divider"/><div className="summary-row"><span>Storage</span><strong>PostgreSQL</strong></div><div className="summary-row"><span>Recognition</span><strong>Live streaming</strong></div></div>
        </div>
      </section>

      <section className="panel history-panel">
        <div className="history-header"><div><span className="section-kicker">YOUR LIBRARY</span><h2>Transcription history <span className="count-badge">{history.length}</span></h2><p>Review, edit, or remove previous sessions.</p></div><div className="search-box"><Search size={17}/><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search transcripts…"/></div></div>
        {history.length === 0 ? <div className="empty-history"><div className="empty-icon"><Clock3 size={22}/></div><strong>No transcriptions yet</strong><span>Your saved sessions will appear here.</span></div> : <div className="history-list">{history.map(item => <div className="history-item" key={item.id}>
          <button className="history-main" onClick={() => setSelected(item)}><div className="history-file-icon"><FileAudio size={19}/></div><div className="history-info"><strong>{item.title}</strong><span>{new Date(item.created_at).toLocaleString()} · {item.transcript.trim().split(/\s+/).length} words</span><p>{item.transcript}</p></div><ChevronRight className="history-chevron" size={18}/></button>
          <div className="history-actions"><button title="Edit transcription" onClick={() => openEdit(item)}><Pencil size={16}/></button><button title="Delete transcription" onClick={() => deleteItem(item.id)}><Trash2 size={16}/></button></div>
        </div>)}</div>}
      </section>
      <footer>Built for the Procucev AI Tech hiring assignment <span>·</span> React + FastAPI + PostgreSQL</footer>
    </main>

    {editing !== null && <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setEditing(null); }}><div className="modal"><div className="modal-heading"><div><span className="section-kicker">EDIT RECORD</span><h2>Update transcription</h2></div><button className="icon-button" onClick={() => setEditing(null)}><X size={18}/></button></div><label className="field-label">Title</label><input className="title-input" value={editTitle} onChange={e => setEditTitle(e.target.value)}/><label className="field-label">Transcript</label><textarea className="edit-textarea" value={editText} onChange={e => setEditText(e.target.value)} rows={7}/><div className="modal-actions"><button className="secondary-button" onClick={() => setEditing(null)}>Cancel</button><button className="primary-button" onClick={saveEdit}><Check size={16}/> Save changes</button></div></div></div>}
    {selected && <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setSelected(null); }}><div className="modal"><div className="modal-heading"><div><span className="section-kicker">TRANSCRIPTION DETAIL</span><h2>{selected.title}</h2></div><button className="icon-button" onClick={() => setSelected(null)}><X size={18}/></button></div><div className="detail-date">{new Date(selected.created_at).toLocaleString()}</div><p className="detail-transcript">{selected.transcript}</p><div className="modal-actions"><button className="secondary-button" onClick={() => { navigator.clipboard?.writeText(selected.transcript); }}>Copy text</button><button className="primary-button" onClick={() => { setSelected(null); openEdit(selected); }}><Pencil size={16}/> Edit record</button></div></div></div>}
  </div>;
}

createRoot(document.getElementById('root')).render(<React.StrictMode><App/></React.StrictMode>);
