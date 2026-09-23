export type TutorialStepId =
  | "prepare"
  | "explore"
  | "lakehouse"
  | "transform"
  | "query"
  | "charts"
  | "canvas";

const SELECTED_PROJECT_KEY = "contoso-selected-project";
const PROGRESS_EVENT = "contoso:tutorial-progress";

export function tutorialProgressKey(scenario:string) {
  return `contoso-project-progress:${scenario}`;
}

export function getSelectedProjectScenario() {
  return localStorage.getItem(SELECTED_PROJECT_KEY) || null;
}

export function setSelectedProjectScenario(scenario:string) {
  localStorage.setItem(SELECTED_PROJECT_KEY,scenario);
}

export function readTutorialProgress(scenario:string):Record<string,boolean> {
  try {
    const raw=localStorage.getItem(tutorialProgressKey(scenario));
    return raw ? JSON.parse(raw) as Record<string,boolean> : {};
  } catch {
    return {};
  }
}

export function writeTutorialProgress(
  scenario:string,
  progress:Record<string,boolean>,
) {
  localStorage.setItem(tutorialProgressKey(scenario),JSON.stringify(progress));
}

export function setTutorialStep(
  step:TutorialStepId,
  complete:boolean,
  scenario?:string|null,
) {
  const selected=getSelectedProjectScenario();
  if (!selected) return false;
  if (scenario && scenario!==selected) return false;
  const target=scenario || selected;

  const current=readTutorialProgress(target);
  if (Boolean(current[step])===complete) return false;

  const next={...current,[step]:complete};
  writeTutorialProgress(target,next);
  window.dispatchEvent(new CustomEvent(PROGRESS_EVENT,{
    detail:{scenario:target,step,complete,progress:next},
  }));
  return true;
}

export function completeTutorialStep(
  step:TutorialStepId,
  scenario?:string|null,
) {
  return setTutorialStep(step,true,scenario);
}

export function resetTutorialProgress(scenario:string) {
  localStorage.removeItem(tutorialProgressKey(scenario));
  window.dispatchEvent(new CustomEvent(PROGRESS_EVENT,{
    detail:{scenario,reset:true,progress:{}},
  }));
}

export function isGoldQuery(sql:string) {
  return /\bcontoso\.gold\./i.test(sql);
}

export const tutorialProgressEvent=PROGRESS_EVENT;
