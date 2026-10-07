// Dashboard icons: Hugeicons' free stroke-rounded set (MIT), as Town draws them (24 grid, stroke 2).
// One place maps the desk's names to Hugeicons, so call sites read like any icon component.
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  Analytics01Icon,
  ArrowDown01Icon,
  ArrowDown02Icon,
  ArrowRight01Icon,
  ArrowRight02Icon,
  ArrowUp01Icon,
  ArrowUp02Icon,
  BookOpen01Icon,
  BotIcon as HugeBotIcon,
  Cancel01Icon,
  ComputerIcon,
  FlashIcon as HugeFlashIcon,
  HelpCircleIcon,
  InboxIcon as HugeInboxIcon,
  LayoutThreeColumnIcon,
  Logout01Icon,
  Moon02Icon,
  PaintBoardIcon,
  Search01Icon,
  Settings02Icon,
  SidebarLeft01Icon,
  Sun03Icon,
  Tick02Icon,
  UserMultipleIcon,
} from "@hugeicons/core-free-icons";
import type { ComponentProps } from "react";

type IconProps = Omit<ComponentProps<typeof HugeiconsIcon>, "icon">;

function make(icon: IconSvgElement) {
  return function Icon(props: IconProps) {
    return <HugeiconsIcon icon={icon} strokeWidth={2} aria-hidden="true" {...props} />;
  };
}

export const ArrowDownIcon = make(ArrowDown02Icon);
export const ArrowRightIcon = make(ArrowRight02Icon);
export const ArrowUpIcon = make(ArrowUp02Icon);
export const BookOpenIcon = make(BookOpen01Icon);
export const BotIcon = make(HugeBotIcon);
export const ChartColumnIcon = make(Analytics01Icon);
export const CheckIcon = make(Tick02Icon);
export const ChevronDownIcon = make(ArrowDown01Icon);
export const ChevronRightIcon = make(ArrowRight01Icon);
export const ChevronUpIcon = make(ArrowUp01Icon);
export const ColumnsIcon = make(LayoutThreeColumnIcon);
export const FlashIcon = make(HugeFlashIcon);
export const HelpIcon = make(HelpCircleIcon);
export const InboxIcon = make(HugeInboxIcon);
export const MonitorIcon = make(ComputerIcon);
export const MoonIcon = make(Moon02Icon);
export const PaletteIcon = make(PaintBoardIcon);
export const SearchIcon = make(Search01Icon);
export const SettingsIcon = make(Settings02Icon);
export const SidebarIcon = make(SidebarLeft01Icon);
export const SignOutIcon = make(Logout01Icon);
export const SunIcon = make(Sun03Icon);
export const UsersIcon = make(UserMultipleIcon);
export const XIcon = make(Cancel01Icon);
