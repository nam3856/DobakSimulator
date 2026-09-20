import { useEffect, useId, useState } from 'react';
import { Boxes, Flame, Gem, Orbit, Route, Sparkles, Star } from 'lucide-react';
import { TAB_GROUPS, TABS, type AppTab } from './constants';
import './simulator-navigation.css';

const tabIcons = {
  cube: Boxes,
  bonusOptions: Flame,
  starforce: Star,
  ability: Sparkles,
  abilityOptimizer: Route,
  soulAmplification: Orbit,
  soulPotential: Gem,
};

type GroupId = (typeof TAB_GROUPS)[number]['id'];

export function SimulatorNavigation({
  activeTab,
  onSelect,
}: {
  activeTab: AppTab;
  onSelect: (tab: AppTab) => void;
}) {
  const subnavigationId = useId();
  const activeGroup =
    TAB_GROUPS.find((group) => (group.tabs as readonly AppTab[]).includes(activeTab)) ??
    TAB_GROUPS[0];
  const [visibleGroupId, setVisibleGroupId] = useState<GroupId>(activeGroup.id);
  const visibleGroup = TAB_GROUPS.find((group) => group.id === visibleGroupId)!;

  useEffect(() => {
    setVisibleGroupId(activeGroup.id);
  }, [activeGroup.id, activeTab]);

  return (
    <nav className="simulator-navigation" aria-label="시뮬레이터">
      <div className="simulator-groups" role="group" aria-label="시뮬레이터 분류">
        {TAB_GROUPS.map((group) => (
          <button
            type="button"
            key={group.id}
            className={visibleGroupId === group.id ? 'active' : ''}
            aria-label={`${group.name} 분류`}
            aria-pressed={visibleGroupId === group.id}
            aria-controls={subnavigationId}
            onClick={() => setVisibleGroupId(group.id)}
          >
            {group.name}
          </button>
        ))}
      </div>
      <div
        id={subnavigationId}
        className="simulator-subtabs"
        role="group"
        aria-label={`${visibleGroup.name} 시뮬레이터`}
      >
        {visibleGroup.tabs.map((tabId) => {
          const tab = TABS.find((item) => item.id === tabId)!;
          const Icon = tabIcons[tabId];
          return (
            <button
              type="button"
              key={tabId}
              className={activeTab === tabId ? 'active' : ''}
              aria-current={activeTab === tabId ? 'page' : undefined}
              onClick={() => {
                if (activeTab !== tabId) onSelect(tabId);
              }}
            >
              <Icon size={17} aria-hidden="true" />
              <span>{tab.name}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
