export interface SessionData {
  role: 'admin' | 'user' | 'participant' | 'team' | 'viewer' | string;
  isSuper?: boolean;
  userId?: string;
  teamId?: string;
  name?: string;
  teamName?: string;
  roll?: string;
  college?: string;
  quizId?: string;
  rid?: string;
  eligible?: boolean;
  cameraStatus?: string;
}

export interface UserRecord {
  id: string;
  name: string;
  roll?: string;
  username: string;
  password?: string;
  college?: string;
  dept?: string;
  year?: string;
  role: string;
  currentQuizId?: string;
  registeredAt?: number;
  email?: string;
}

export interface TeamRecord {
  id: string;
  name: string;
  username?: string;
  password?: string;
  teamNumber?: number;
  status?: string;
  score?: number;
  correctCount?: number;
  wrongCount?: number;
  passCount?: number;
  quizId?: string;
  members?: any[];
}

export interface RoundRecord {
  id: string | number;
  num?: number;
  name: string;
  stage?: string;
  questionCount?: number;
  timePerQuestion?: number;
  pointsCorrect?: number;
  pointsWrong?: number;
  instructions?: string;
}

export interface QuestionRecord {
  id: string | number;
  roundId?: string | number;
  text: string;
  options: string[];
  correct: number[];
  explanation?: string;
}

export interface QuizState {
  status: 'idle' | 'round_intro' | 'running' | 'paused' | 'participant_turn' | 'round_end' | 'finished' | string;
  currentRoundIdx: number;
  currentQInRound: number;
  globalQIdx: number;
  questionStartTeamIdx: number;
  currentTeamIdx: number;
  passChain: string[];
  participantTurn: boolean;
  participantTimerStart: number | null;
  participantTimeLimit: number;
  timerStart: number | null;
  timerLimit: number;
  roundTimerStart: number | null;
  roundTimeLimit: number;
  competitionStart: number | null;
  overallTimeLimit: number;
  _timerEndHandled: boolean;
  _roundTimerEnded: boolean;
  _participantTimerHandled: boolean;
  _advancing?: boolean;
  _advancingTime?: number | null;
}

export interface SettingsConfig {
  adminUsername: string;
  adminPassword: string;
  captchaCode: string;
  defaultTimePerQuestion: number;
  participantTimeLimit: number;
  overallTimeLimit: number;
  globalInstructions: string;
  prizes: string[];
  [key: string]: any;
}

export interface SyncSocket {
  connected: boolean;
  emit(event: string, data: any): void;
  on(event: string, cb: (data: any) => void): void;
}

declare global {
  interface Window {
    socket?: SyncSocket;
    Razorpay?: any;
    bootstrap?: any;
    [key: string]: any;
  }
}
