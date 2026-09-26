import { useEffect, useRef, useState } from 'react';
import { MessageCircle, Send, X, ArrowUpRight, Tag, MapPin, Mail, Clock, Search, Truck, Wallet } from 'lucide-react';
import './LandingChatbot.css';
import FacebookIcon from './FacebookIcon';

const topics = ['Prices per load', 'Shop location', 'Contact management', 'Opening hours', 'Track my order', 'Pickup / delivery', 'Payment'];
const topicIcons = [Tag, MapPin, Mail, Clock, Search, Truck, Wallet];
const contact = 'Call 0967-281-3602, email iclaundryshop@gmail.com, or message I and C Laundry Hub on Facebook. You can also use the Contact Us form below.';
export function answerQuestion(question, settings = {}) {
  const q = question.toLowerCase().trim();
  if (/price|cost|magkano|presyo|per load|extra|add.?on|kilo|\bkg\b/.test(q)) {
    return { text: 'Prices are configured separately for each service, such as regular laundry, comforters, pads, and air-dry-only gowns. Add-on prices also depend on the selected service and branch. Please contact the shop so staff can confirm the current per-load rate and final total.', section: 'contact' };
  }
  if (/location|address|branch|map|directions|(?:where|saan).*(?:shop|store|located|kayo)/.test(q))
    return { text: 'Our listed shop address is Paz Street, Brgy. 7, Balayan, Batangas. Contact management for directions or details about other branches.', section: 'contact', map: true };
  if (/facebook|messenger|\bfb\b/.test(q)) return { text: 'You can contact us through our Facebook page, I and C Laundry Hub.', facebook: true };
  if (/contact|management|manager|phone|email|gmail|call|complaint|reklamo/.test(q)) return { text: contact, section: 'contact', facebook: true };
  if (/hour|open|close|schedule|bukas|oras/.test(q)) return { text: 'Please contact the shop to confirm today’s opening hours and holiday schedule. ' + contact, section: 'contact' };
  if (/track|status|ready|when|long|tapos|claim|receipt/.test(q)) return { text: 'Use Track Your Laundry below and enter the complete tracking number from your receipt. You can see the order stage and estimated ready time there. Estimates may change as work progresses; please wait for Ready for pick-up before collecting.', section: 'track' };
  if (/delivery|deliver|pickup|pick.up|collect/.test(q)) return { text: 'Please contact management to confirm whether pickup or delivery is available in your area and any charges. For collection at the shop, check that your order is ready and bring your receipt or tracking number.', section: 'contact' };
  if (/payment|pay|cash|gcash|card|bayad|deposit/.test(q)) return { text: 'Orders require at least 50% payment of the final total when placed. Please ask staff about accepted payment methods and settle the remaining balance before release.', section: 'contact' };
  if (/loyalty|reward|discount|promo|free/.test(q)) return { text: 'Loyalty benefits depend on your qualifying transaction history and the current program settings. Staff can check your eligibility and confirm any discount before you pay.', section: 'contact' };
  if (/^(hi|hello|hey|good morning|good afternoon|good evening|salamat|thanks)[! .]*$/.test(q)) return { text: 'Hello! I can help with prices, directions, contact details, services, and order tracking. Choose a topic below or type your question.' };
  return {
    text: 'Sorry, I do not have a confirmed answer for that yet, so I do not want to give you incorrect information. Please try asking about prices, location, payment, order tracking, or contact details. For anything else, our team can help through the Contact Us form or I and C Laundry Hub on Facebook.',
    section: 'contact',
    facebook: true,
  };
}

export default function LandingChatbot({ settings }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [messages, setMessages] = useState([{ id: 0, text: 'Hi! Welcome to I&C Laundry. How can I help you today?' }]);
  const [isTyping, setIsTyping] = useState(false);
  const nextMessageId = useRef(1);
  const replyTimer = useRef(null);
  const input = useRef(null);
  const launcher = useRef(null);
  const log = useRef(null);
  const topicDrag = useRef({ active: false, moved: false, startX: 0, startScrollLeft: 0, suppressClick: false });
  useEffect(() => { if (open) input.current?.focus(); }, [open]);
  useEffect(() => { if (log.current) log.current.scrollTop = log.current.scrollHeight; }, [messages, open]);
  useEffect(() => () => window.clearTimeout(replyTimer.current), []);
  const close = () => { setOpen(false); launcher.current?.focus(); };
  const ask = question => {
    const text = question.trim().slice(0, 300);
    if (!text || isTyping) return;
    const userMessage = { id: nextMessageId.current++, text, user: true };
    const reply = { ...answerQuestion(text, settings), id: nextMessageId.current++ };
    setMessages(previous => [...previous.slice(-39), userMessage]);
    setDraft('');
    setIsTyping(true);
    replyTimer.current = window.setTimeout(() => {
      setMessages(previous => [...previous.slice(-39), reply]);
      setIsTyping(false);
      replyTimer.current = null;
    }, 550);
  };
  const goTo = section => {
    close();
    const target = document.getElementById(section);
    target?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    target?.querySelector('input')?.focus({ preventScroll: true });
  };
  const startTopicDrag = event => {
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    const rail = event.currentTarget;
    if (rail.scrollWidth <= rail.clientWidth) return;
    topicDrag.current = { ...topicDrag.current, active: true, moved: false, startX: event.clientX, startScrollLeft: rail.scrollLeft };
    rail.setPointerCapture?.(event.pointerId);
  };
  const moveTopicDrag = event => {
    const drag = topicDrag.current;
    if (!drag.active) return;
    const distance = event.clientX - drag.startX;
    if (Math.abs(distance) <= 3 && !drag.moved) return;
    drag.moved = true;
    event.currentTarget.classList.add('is-mouse-dragging');
    event.currentTarget.scrollLeft = drag.startScrollLeft - distance;
    event.preventDefault();
  };
  const finishTopicDrag = event => {
    const drag = topicDrag.current;
    if (!drag.active) return;
    event.currentTarget.classList.remove('is-mouse-dragging');
    topicDrag.current = { ...drag, active: false, suppressClick: drag.moved };
    if (drag.moved) window.setTimeout(() => { topicDrag.current.suppressClick = false; }, 0);
  };
  return <div className="laundry-chat">
    {open && <section id="laundry-chat-panel" className="laundry-chat-panel" role="dialog" aria-modal="false" aria-labelledby="laundry-chat-title" onKeyDown={event => { if (event.key === 'Escape') close(); }}>
      <header className="laundry-chat-header">
        <div className="laundry-chat-avatar"><img src="/assets/Rectangle.png" alt="I&C Laundry" /></div>
        <div><h2 id="laundry-chat-title">I&C Laundry assistant</h2><p><span className="laundry-chat-status" /> Your automated FAQ guide</p></div>
        <button type="button" onClick={close} aria-label="Close chat"><X size={21} /></button>
      </header>
      <div ref={log} className="laundry-chat-log" role="log" aria-live="polite" aria-relevant="additions" aria-label="Conversation">
        <div className="laundry-chat-intro" aria-hidden="true"><span>A LITTLE HELP, A LOT LESS HASSLE</span><p>Fresh answers. Just ask.</p></div>
        {messages.map(message => <div key={message.id} className={`laundry-chat-message ${message.user ? 'is-user' : ''}`}>
          <span className="laundry-chat-speaker">{message.user ? 'You' : 'I&C assistant'}</span>
          <p>{message.text}</p>
          {message.section && <button type="button" onClick={() => goTo(message.section)}>{message.section === 'track' ? 'Track your laundry' : message.section === 'process' ? 'See our process' : 'Contact our team'} →</button>}
          {message.map && <a href="https://www.google.com/maps/search/?api=1&query=Paz+Street+Brgy+7+Balayan+Batangas" target="_blank" rel="noopener noreferrer">Find the area on Google Maps ↗</a>}
          {message.facebook && <a className="laundry-chat-facebook-link" href="https://web.facebook.com/profile.php?id=100089597336119" target="_blank" rel="noopener noreferrer"><FacebookIcon size={14} title="" /> Open I and C Laundry Hub on Facebook ↗</a>}
        </div>)}
        {isTyping && <div className="laundry-chat-typing" role="status" aria-label="I&C Laundry assistant is typing"><img src="/assets/Rectangle.png" alt="" /><div><span>I&C assistant is replying</span><p><i /><i /><i /></p></div></div>}
      </div>
      <div className="laundry-chat-suggestions"><span className="laundry-chat-topics-label">Explore a quick question</span><div className="laundry-chat-topics" aria-label="Suggested questions" onPointerDown={startTopicDrag} onPointerMove={moveTopicDrag} onPointerUp={finishTopicDrag} onPointerCancel={finishTopicDrag} onClickCapture={event => { if (topicDrag.current.suppressClick) { event.preventDefault(); event.stopPropagation(); } }}>{topics.map((topic, index) => { const Icon = topicIcons[index]; return <button type="button" key={topic} onClick={() => ask(topic)} disabled={isTyping}><Icon size={14} aria-hidden="true" />{topic}<ArrowUpRight className="laundry-chat-topic-arrow" size={13} aria-hidden="true" /></button>; })}</div></div>
      <form className="laundry-chat-form" onSubmit={event => { event.preventDefault(); ask(draft); }}>
        <input ref={input} aria-label="Your question" placeholder="Ask a quick question…" maxLength={300} value={draft} onChange={event => setDraft(event.target.value)} />
        <button type="submit" disabled={!draft.trim() || isTyping} aria-label="Send question"><Send size={19} /></button>
      </form>
      <p className="laundry-chat-note">For personal order concerns, contact our team.</p>
    </section>}
    <button ref={launcher} type="button" className="laundry-chat-launcher" aria-expanded={open} aria-controls="laundry-chat-panel" onClick={() => open ? close() : setOpen(true)}><span className="laundry-chat-launcher-icon">{open ? <X size={22} /> : <MessageCircle size={22} />}</span><span>{open ? 'Close' : 'FAQ'}</span></button>
  </div>;
}
