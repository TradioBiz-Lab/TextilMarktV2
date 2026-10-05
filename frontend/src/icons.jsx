import { forwardRef, useState } from 'react'
import {
  ArrowClockwise as P_ArrowClockwise,
  ArrowLeft as P_ArrowLeft,
  ArrowRight as P_ArrowRight,
  ArrowsClockwise as P_ArrowsClockwise,
  ArrowsLeftRight as P_ArrowsLeftRight,
  Bell as P_Bell,
  Buildings as P_Buildings,
  CalendarBlank as P_CalendarBlank,
  CalendarDots as P_CalendarDots,
  Camera as P_Camera,
  CaretDoubleLeft as P_CaretDoubleLeft,
  CaretDoubleRight as P_CaretDoubleRight,
  CaretDown as P_CaretDown,
  CaretLeft as P_CaretLeft,
  CaretRight as P_CaretRight,
  CaretUp as P_CaretUp,
  ChartBar as P_ChartBar,
  ChatCircle as P_ChatCircle,
  ChatText as P_ChatText,
  Check as P_Check,
  CheckCircle as P_CheckCircle,
  Circle as P_Circle,
  ClipboardText as P_ClipboardText,
  ClockCounterClockwise as P_ClockCounterClockwise,
  CloudArrowUp as P_CloudArrowUp,
  Crown as P_Crown,
  DownloadSimple as P_DownloadSimple,
  Envelope as P_Envelope,
  Eye as P_Eye,
  EyeSlash as P_EyeSlash,
  Factory as P_Factory,
  FileText as P_FileText,
  FileXls as P_FileXls,
  Flask as P_Flask,
  FolderSimple as P_FolderSimple,
  Hexagon as P_Hexagon,
  House as P_House,
  Image as P_Image,
  Info as P_Info,
  Key as P_Key,
  Leaf as P_Leaf,
  Lightning as P_Lightning,
  LinkSimple as P_LinkSimple,
  List as P_List,
  ListBullets as P_ListBullets,
  ListChecks as P_ListChecks,
  MagnifyingGlass as P_MagnifyingGlass,
  Megaphone as P_Megaphone,
  Microphone as P_Microphone,
  Note as P_Note,
  NotePencil as P_NotePencil,
  Package as P_Package,
  Palette as P_Palette,
  PaperPlaneTilt as P_PaperPlaneTilt,
  Paperclip as P_Paperclip,
  PencilLine as P_PencilLine,
  PencilSimple as P_PencilSimple,
  Play as P_Play,
  Plus as P_Plus,
  Prohibit as P_Prohibit,
  RadioButton as P_RadioButton,
  Ruler as P_Ruler,
  Scissors as P_Scissors,
  Shield as P_Shield,
  ShieldCheck as P_ShieldCheck,
  ShieldPlus as P_ShieldPlus,
  ShieldWarning as P_ShieldWarning,
  ShoppingBag as P_ShoppingBag,
  ShoppingCart as P_ShoppingCart,
  SignOut as P_SignOut,
  Siren as P_Siren,
  SlidersHorizontal as P_SlidersHorizontal,
  Sparkle as P_Sparkle,
  SpeakerHigh as P_SpeakerHigh,
  Square as P_Square,
  SquaresFour as P_SquaresFour,
  Stack as P_Stack,
  TShirt as P_TShirt,
  Target as P_Target,
  Trash as P_Trash,
  Tray as P_Tray,
  Trophy as P_Trophy,
  Truck as P_Truck,
  UploadSimple as P_UploadSimple,
  User as P_User,
  Users as P_Users,
  Wallet as P_Wallet,
  Warning as P_Warning,
  Waveform as P_Waveform,
  WifiSlash as P_WifiSlash,
  X as P_X,
  XCircle as P_XCircle,
} from '@phosphor-icons/react'

// The portal's one icon set (Phosphor). Every screen imports icons from here, never
// from the library directly, so the look is tuned in this file and the set can be
// swapped later without touching the pages.
//
// The wrappers accept the props the old icon set used (size, strokeWidth, fill, color)
// so call sites did not have to change:
//   - fill="<colour>"        -> the filled weight in that colour (e.g. a Play triangle)
//   - strokeWidth >= 2.5     -> bold (the old way of asking for a heavier tick or cross)
//   - size <= 12             -> bold, because a regular-weight stroke goes hairline when tiny
//   - otherwise              -> regular
const weightFor = ({ size, strokeWidth, fill }) => {
  if (fill && fill !== 'none') return 'fill'
  if (strokeWidth >= 2.5) return 'bold'
  if (typeof size === 'number' && size <= 12) return 'bold'
  return 'regular'
}

const make = (Icon, name) => {
  const Wrapped = forwardRef(function AppIcon({ size = 16, strokeWidth, fill, color, ...rest }, ref) {
    const filled = fill && fill !== 'none'
    return <Icon ref={ref} size={size} weight={weightFor({ size, strokeWidth, fill })} color={filled ? fill : color} {...rest} />
  })
  Wrapped.displayName = name
  return Wrapped
}

export const AlertTriangle = make(P_Warning, 'AlertTriangle')
export const ArrowLeft = make(P_ArrowLeft, 'ArrowLeft')
export const ArrowLeftRight = make(P_ArrowsLeftRight, 'ArrowLeftRight')
export const ArrowRight = make(P_ArrowRight, 'ArrowRight')
export const AudioLines = make(P_Waveform, 'AudioLines')
export const Ban = make(P_Prohibit, 'Ban')
export const BarChart3 = make(P_ChartBar, 'BarChart3')
export const Bell = make(P_Bell, 'Bell')
// Kriyaa's mark: a robot head with two round eyes, ears and an antenna, deliberately with NO mouth.
// Phosphor's own robot has a wide grin that reads as creepy at size, so this one is drawn here and
// follows the same weight rules as the rest of the set (bold when tiny, duotone/fill add a tint).
// It blinks (a quick eyelid-close every few seconds, see .kriyaa-eye in index.css) when it is big enough
// to notice, never in the small sidebar slot, and `blink={false}` turns it off. Each robot starts at a
// random point in the cycle so several on one screen do not blink in unison.
export const Bot = forwardRef(function Bot({ size = 16, strokeWidth, fill, color = 'currentColor', weight, style, blink, ...rest }, ref) {
  const w = weight || weightFor({ size, strokeWidth, fill })
  const doBlink = blink ?? size >= 22
  const [phase] = useState(() => `-${(Math.random() * 5.5).toFixed(2)}s`)
  const eye = doBlink ? { className: 'kriyaa-eye', style: { animationDelay: phase } } : {}
  const stroke = w === 'bold' ? 2.2 : w === 'light' ? 1.2 : 1.6
  const tint = w === 'fill' ? 0.38 : w === 'duotone' ? 0.22 : 0
  const ink = fill && fill !== 'none' ? fill : color
  return (
    <svg ref={ref} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={ink} strokeWidth={stroke}
      strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, ...style }} aria-hidden="true" {...rest}>
      <path d="M12 7.2V4.2" />
      <circle cx="12" cy="3.1" r="1" fill={ink} stroke="none" />
      <rect x="4.2" y="7.2" width="15.6" height="12.6" rx="4.2" fill={ink} fillOpacity={tint} />
      <path d="M2 12.8v3" />
      <path d="M22 12.8v3" />
      <circle cx="9" cy="13.2" r="1.25" fill={ink} stroke="none" {...eye} />
      <circle cx="15" cy="13.2" r="1.25" fill={ink} stroke="none" {...eye} />
    </svg>
  )
})
Bot.displayName = 'Bot'
export const Building2 = make(P_Buildings, 'Building2')
export const Calendar = make(P_CalendarBlank, 'Calendar')
export const CalendarClock = make(P_CalendarDots, 'CalendarClock')
export const Camera = make(P_Camera, 'Camera')
export const Check = make(P_Check, 'Check')
export const CheckCircle2 = make(P_CheckCircle, 'CheckCircle2')
export const ChevronDown = make(P_CaretDown, 'ChevronDown')
export const ChevronLeft = make(P_CaretLeft, 'ChevronLeft')
export const ChevronRight = make(P_CaretRight, 'ChevronRight')
export const ChevronUp = make(P_CaretUp, 'ChevronUp')
export const ChevronsLeft = make(P_CaretDoubleLeft, 'ChevronsLeft')
export const ChevronsRight = make(P_CaretDoubleRight, 'ChevronsRight')
export const Circle = make(P_Circle, 'Circle')
export const CircleDot = make(P_RadioButton, 'CircleDot')
export const ClipboardEdit = make(P_NotePencil, 'ClipboardEdit')
export const ClipboardList = make(P_ClipboardText, 'ClipboardList')
export const Crown = make(P_Crown, 'Crown')
export const Download = make(P_DownloadSimple, 'Download')
export const Eye = make(P_Eye, 'Eye')
export const EyeOff = make(P_EyeSlash, 'EyeOff')
export const Factory = make(P_Factory, 'Factory')
export const FileSpreadsheet = make(P_FileXls, 'FileSpreadsheet')
export const FileText = make(P_FileText, 'FileText')
export const FlaskConical = make(P_Flask, 'FlaskConical')
export const Folder = make(P_FolderSimple, 'Folder')
export const Hexagon = make(P_Hexagon, 'Hexagon')
export const History = make(P_ClockCounterClockwise, 'History')
export const Home = make(P_House, 'Home')
export const Image = make(P_Image, 'Image')
export const Inbox = make(P_Tray, 'Inbox')
export const Info = make(P_Info, 'Info')
export const KeyRound = make(P_Key, 'KeyRound')
export const Layers = make(P_Stack, 'Layers')
export const LayoutGrid = make(P_SquaresFour, 'LayoutGrid')
export const Leaf = make(P_Leaf, 'Leaf')
export const Link2 = make(P_LinkSimple, 'Link2')
export const List = make(P_ListBullets, 'List')
export const ListChecks = make(P_ListChecks, 'ListChecks')
export const ListTodo = make(P_ListBullets, 'ListTodo')
export const LogOut = make(P_SignOut, 'LogOut')
export const Mail = make(P_Envelope, 'Mail')
export const Megaphone = make(P_Megaphone, 'Megaphone')
export const Menu = make(P_List, 'Menu')
export const MessageCircle = make(P_ChatCircle, 'MessageCircle')
export const MessageSquare = make(P_ChatText, 'MessageSquare')
export const Mic = make(P_Microphone, 'Mic')
export const Package = make(P_Package, 'Package')
export const Palette = make(P_Palette, 'Palette')
export const Paperclip = make(P_Paperclip, 'Paperclip')
export const PenLine = make(P_PencilLine, 'PenLine')
export const Pencil = make(P_PencilSimple, 'Pencil')
export const Play = make(P_Play, 'Play')
export const Plus = make(P_Plus, 'Plus')
export const RefreshCw = make(P_ArrowsClockwise, 'RefreshCw')
export const RotateCw = make(P_ArrowClockwise, 'RotateCw')
export const Ruler = make(P_Ruler, 'Ruler')
export const Scissors = make(P_Scissors, 'Scissors')
export const Search = make(P_MagnifyingGlass, 'Search')
export const Send = make(P_PaperPlaneTilt, 'Send')
export const Settings2 = make(P_SlidersHorizontal, 'Settings2')
export const Shield = make(P_Shield, 'Shield')
export const ShieldAlert = make(P_ShieldWarning, 'ShieldAlert')
export const ShieldCheck = make(P_ShieldCheck, 'ShieldCheck')
export const ShieldPlus = make(P_ShieldPlus, 'ShieldPlus')
export const Shirt = make(P_TShirt, 'Shirt')
export const ShoppingBag = make(P_ShoppingBag, 'ShoppingBag')
export const ShoppingCart = make(P_ShoppingCart, 'ShoppingCart')
export const Siren = make(P_Siren, 'Siren')
export const Sparkles = make(P_Sparkle, 'Sparkles')
export const Square = make(P_Square, 'Square')
export const StickyNote = make(P_Note, 'StickyNote')
export const Target = make(P_Target, 'Target')
export const Trash2 = make(P_Trash, 'Trash2')
export const Trophy = make(P_Trophy, 'Trophy')
export const Truck = make(P_Truck, 'Truck')
export const Upload = make(P_UploadSimple, 'Upload')
export const UploadCloud = make(P_CloudArrowUp, 'UploadCloud')
export const User = make(P_User, 'User')
export const Users = make(P_Users, 'Users')
export const Volume2 = make(P_SpeakerHigh, 'Volume2')
export const Wallet = make(P_Wallet, 'Wallet')
export const WifiOff = make(P_WifiSlash, 'WifiOff')
export const X = make(P_X, 'X')
export const XCircle = make(P_XCircle, 'XCircle')
export const Zap = make(P_Lightning, 'Zap')
