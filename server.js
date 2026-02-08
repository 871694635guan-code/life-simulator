const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// 模拟状态
let simulationState = {
    isRunning: false,
    isPaused: false,
    isWaitingForResume: false,  // 新增：标记是否在等待用户继续
    config: null,
    targets: [],
    currentAge: 0,
    currentDayInYear: 1,
    dayCount: 0,
    currentMoney: 0,
    logs: [],
    history: { 
        wins: 0, 
        losses: 0, 
        totalGambles: 0,
        workDays: 0,
        gambleDays: 0
    },
    stats: {
        totalDays: 0,
        workCount: 0,
        gambleCount: 0,
        totalIncome: 0,
        totalExpenses: 0
    }
};

// 重置
function resetState() {
    simulationState = {
        isRunning: false,
        isPaused: false,
        isWaitingForResume: false,
        config: null,
        targets: [],
        currentAge: 0,
        currentDayInYear: 1,
        dayCount: 0,
        currentMoney: 0,
        logs: [],
        history: { wins: 0, losses: 0, totalGambles: 0, workDays: 0, gambleDays: 0 },
        stats: {
            totalDays: 0,
            workCount: 0,
            gambleCount: 0,
            totalIncome: 0,
            totalExpenses: 0
        }
    };
}

// 计算累计目标
function getAccumulatedTargets(targets) {
    const sorted = [...targets].sort((a, b) => a.deadlineAge - b.deadlineAge);
    let accumulated = 0;
    return sorted.map(t => {
        accumulated += t.amount;
        return {
            ...t,
            accumulatedAmount: accumulated,
            remainingAmount: accumulated
        };
    });
}

// 计算真实压力
function calculateRealPressure(state) {
    const { currentMoney, currentAge, dayCount, currentDayInYear, config, targets, history } = state;
    
    if (targets.length === 0) return { pressure: 0, emoji: '😊', text: '无目标', reason: '' };
    
    const accTargets = getAccumulatedTargets(targets);
    const activeTargets = accTargets.filter(t => !t.completed && t.deadlineAge >= currentAge);
    
    if (activeTargets.length === 0) {
        return { pressure: 0, emoji: '🎉', text: '全部完成', reason: '所有目标已达成' };
    }
    
    const currentTarget = activeTargets[0];
    const remainingMoney = currentTarget.accumulatedAmount - currentMoney;
    const remainingDays = (currentTarget.deadlineAge - currentAge) * 365 - currentDayInYear;
    
    if (remainingDays <= 0) {
        return { 
            pressure: 100, 
            emoji: '💀', 
            text: '目标已超时', 
            reason: `已超${currentTarget.deadlineAge}岁时限，还差${remainingMoney}元`,
            currentTarget,
            remainingMoney,
            remainingDays: 0
        };
    }
    
    const dailyRequired = remainingMoney / remainingDays;
    const safeIncome = config.workIncome - config.dailyCost;
    
    let basePressure = 0;
    if (dailyRequired <= 0) basePressure = 0;
    else if (dailyRequired <= safeIncome * 0.3) basePressure = 10;
    else if (dailyRequired <= safeIncome * 0.6) basePressure = 25;
    else if (dailyRequired <= safeIncome * 0.9) basePressure = 40;
    else if (dailyRequired <= safeIncome * 1.2) basePressure = 55;
    else if (dailyRequired <= safeIncome * 1.8) basePressure = 75;
    else basePressure = 90;
    
    const totalDaysForTarget = (currentTarget.deadlineAge - config.startAge) * 365;
    const timeRatio = dayCount / totalDaysForTarget;
    const timePressure = timeRatio * 20;
    
    const failRatio = history.totalGambles > 0 ? (history.losses / history.totalGambles) : 0;
    const failPressure = failRatio * 15;
    
    const expectedProgress = timeRatio * currentTarget.accumulatedAmount;
    const progressDeficit = Math.max(0, (expectedProgress - currentMoney) / currentTarget.accumulatedAmount);
    const progressPressure = progressDeficit * 25;
    
    let totalPressure = Math.min(100, basePressure + timePressure + failPressure + progressPressure);
    
    let emoji = '😊', text = '轻松', reason = '';
    if (totalPressure > 15) { emoji = '😌'; text = '平稳'; }
    if (totalPressure > 35) { emoji = '🤔'; text = '思考中'; }
    if (totalPressure > 55) { emoji = '😰'; text = '焦虑'; }
    if (totalPressure > 75) { emoji = '🤯'; text = '高压'; }
    if (totalPressure > 90) { emoji = '💀'; text = '绝望'; }
    
    reason = `需日均${dailyRequired.toFixed(0)}元|时间${(timeRatio*100).toFixed(0)}%|败率${(failRatio*100).toFixed(0)}%|落后${(progressDeficit*100).toFixed(0)}%`;
    
    return { 
        pressure: Math.round(totalPressure), 
        emoji, 
        text, 
        reason,
        currentTarget,
        remainingMoney,
        remainingDays,
        dailyRequired
    };
}

// AI决策（无限重试）
async function makeAIDecision(state, pressureInfo) {
    const { config, currentMoney, currentAge, history, currentDayInYear } = state;
    const { pressure, dailyRequired, remainingDays, currentTarget } = pressureInfo;
    
    const workNet = config.workIncome - config.dailyCost;
    const gambleExpected = (config.gambleWinRate/100) * config.gambleWinAmount - 
                          ((100-config.gambleWinRate)/100) * config.gambleLossAmount - config.dailyCost;
    
    const prompt = `你是一个在人生模拟器中做决策的AI。请根据当前状态选择今天的行动。

【当前状态】
- 年龄：${currentAge}岁第${currentDayInYear}天
- 存款：${currentMoney.toLocaleString()}元
- 当前目标：${currentTarget ? currentTarget.description : '无'} (累计需${currentTarget ? currentTarget.accumulatedAmount.toLocaleString() : 0}元)
- 距离时限：${remainingDays}天
- 压力值：${pressure}/100 (${pressureInfo.text})
- 历史统计：打工${history.workDays}天，赌博${history.gambleDays}天(赢${history.wins}输${history.losses})

【选项分析】
1. 打工：稳定赚${workNet}元/天
2. 赌博：${config.gambleWinRate}%概率赚${config.gambleWinAmount}元，${100-config.gambleWinRate}%概率赔${config.gambleLossAmount}元，期望收益${gambleExpected}元/天

【决策要求】
- 分析当前压力、时间紧迫性和历史表现
- 必须选择"打工"或"赌博"之一
- 简要说明理由（1句话）

请以JSON格式回复：{"action": "打工"或"赌博", "reason": "理由"}`;

    let attempt = 0;
    while (true) {
        try {
            if (simulationState.isPaused) {
                throw new Error('Simulation paused');
            }
            
            const response = await axios.post('https://api.siliconflow.cn/v1/chat/completions', {
                model: "deepseek-ai/DeepSeek-V2.5",
                messages: [
                    { role: "system", content: "你是一个理性决策AI，会根据风险和收益做选择。必须返回JSON格式。" },
                    { role: "user", content: prompt }
                ],
                temperature: 0.7,
                max_tokens: 200
            }, {
                headers: {
                    'Authorization': `Bearer ${process.env.SILICONFLOW_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            });
            
            const content = response.data.choices[0].message.content;
            const match = content.match(/\{.*\}/s);
            if (match) {
                const decision = JSON.parse(match[0]);
                return {
                    action: decision.action.includes('赌') ? 'gamble' : 'work',
                    reason: decision.reason || 'AI分析后决策',
                    isAI: true
                };
            }
        } catch (error) {
            attempt++;
            console.log(`AI调用尝试${attempt}失败:`, error.message);
            
            if (error.message === 'Simulation paused') {
                throw error;
            }
            
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
}

// 执行行动
function executeAction(action, config) {
    if (action === 'work') {
        return {
            income: config.workIncome,
            netIncome: config.workIncome - config.dailyCost,
            action: '💼 打工',
            description: '踏实工作一天'
        };
    } else {
        const isWin = Math.random() * 100 < config.gambleWinRate;
        if (isWin) {
            return {
                income: config.gambleWinAmount,
                netIncome: config.gambleWinAmount - config.dailyCost,
                action: '🎰 赌博-赢!',
                description: `运气不错！赢了${config.gambleWinAmount}元`,
                isWin: true
            };
        } else {
            return {
                income: -config.gambleLossAmount,
                netIncome: -config.gambleLossAmount - config.dailyCost,
                action: '💸 赌博-输!',
                description: `倒霉！输了${config.gambleLossAmount}元`,
                isWin: false
            };
        }
    }
}

// API路由
app.post('/simulate', async (req, res) => {
    const { action, config, targets, speed } = req.body;
    
    // 开始
    if (action === 'start') {
        resetState();
        simulationState.isRunning = true;
        simulationState.isPaused = false;
        simulationState.isWaitingForResume = false;
        simulationState.config = config;
        simulationState.targets = getAccumulatedTargets(targets.map(t => ({...t, completed: false})));
        simulationState.currentAge = config.startAge;
        simulationState.speed = speed || 500;
        
        return res.json({ 
            success: true, 
            message: '模拟开始',
            state: getClientState()
        });
    }
    
    // 重置
    if (action === 'reset') {
        resetState();
        return res.json({ success: true, message: '已重置', state: getClientState() });
    }
    
    // 暂停（关键修复：设置暂停标志，等待当前天完成）
    if (action === 'pause') {
        simulationState.isPaused = true;
        // 不立即停止，让当前正在执行的这天完成
        
        return res.json({ 
            success: true, 
            message: '已请求暂停，等待当前天完成',
            state: getClientState()
        });
    }
    
    // 继续
    if (action === 'resume') {
        if (config) {
            const originalStartAge = simulationState.config.startAge;
            simulationState.config = {
                ...config,
                startAge: originalStartAge
            };
        }
        if (targets) {
            const oldCompleted = simulationState.targets.filter(t => t.completed);
            const newTargets = targets.map(t => {
                const old = oldCompleted.find(o => o.description === t.description);
                return old || {...t, completed: false};
            });
            simulationState.targets = getAccumulatedTargets(newTargets);
        }
        
        simulationState.isPaused = false;
        simulationState.isWaitingForResume = false;
        simulationState.isRunning = true;
        
        return res.json({ 
            success: true, 
            message: '继续模拟',
            state: getClientState()
        });
    }
    
    // 执行一天（关键修复：检查暂停标志，完成这天后不再自动继续）
    if (action === 'step') {
        // 如果已暂停且正在等待，拒绝执行
        if (!simulationState.isRunning || (simulationState.isPaused && simulationState.isWaitingForResume)) {
            return res.json({ 
                success: false, 
                message: '已暂停，等待继续',
                paused: true 
            });
        }
        
        const state = simulationState;
        
        // 检查超时
        if (state.currentAge >= state.config.deadlineAge) {
            state.isRunning = false;
            return res.json({
                success: true,
                finished: true,
                reason: 'timeout',
                message: `⏰ 时间到！${state.currentAge}岁，模拟结束`,
                state: getClientState()
            });
        }
        
        // 计算压力
        const pressureInfo = calculateRealPressure(state);
        
        // AI决策
        let decision;
        try {
            decision = await makeAIDecision(state, pressureInfo);
        } catch (error) {
            if (error.message === 'Simulation paused') {
                return res.json({ 
                    success: false, 
                    message: '模拟已暂停',
                    paused: true 
                });
            }
            throw error;
        }
        
        const result = executeAction(decision.action, state.config);
        
        // 更新统计
        state.stats.totalDays++;
        state.stats.totalIncome += result.income;
        state.stats.totalExpenses += state.config.dailyCost;
        
        if (decision.action === 'work') {
            state.history.workDays++;
            state.stats.workCount++;
        } else {
            state.history.gambleDays++;
            state.stats.gambleCount++;
        }
        
        // 更新状态
        state.currentMoney += result.netIncome;
        state.dayCount++;
        state.currentDayInYear++;
        
        // 更新赌博历史
        if (decision.action === 'gamble') {
            state.history.totalGambles++;
            if (result.isWin) state.history.wins++;
            else state.history.losses++;
        }
        
        // 年份推进
        let yearPassed = false;
        if (state.currentDayInYear > 365) {
            state.currentDayInYear = 1;
            state.currentAge++;
            yearPassed = true;
        }
        
        // 检查目标完成
        const accTargets = getAccumulatedTargets(state.targets);
        let completedTarget = null;
        for (let target of accTargets) {
            if (!target.completed && state.currentMoney >= target.accumulatedAmount && state.currentAge <= target.deadlineAge) {
                target.completed = true;
                target.completedAge = state.currentAge;
                completedTarget = target;
                break;
            }
        }
        
        // 检查是否全部完成
        const allCompleted = state.targets.every(t => t.completed);
        
        // 记录日志
        const logEntry = {
            day: state.dayCount,
            age: state.currentAge,
            dayInYear: state.currentDayInYear,
            action: result.action,
            income: result.income,
            dailyCost: state.config.dailyCost,
            netIncome: result.netIncome,
            totalMoney: state.currentMoney,
            pressure: pressureInfo.pressure,
            pressureEmoji: pressureInfo.emoji,
            pressureText: pressureInfo.text,
            pressureReason: pressureInfo.reason,
            description: result.description,
            decisionReason: decision.reason,
            isAI: decision.isAI,
            yearPassed,
            completedTarget: completedTarget ? {
                name: completedTarget.description,
                amount: completedTarget.accumulatedAmount
            } : null,
            stats: {...state.stats}
        };
        state.logs.push(logEntry);
        
        // 关键：如果已请求暂停，设置等待标志，不再自动继续
        if (state.isPaused) {
            state.isWaitingForResume = true;
        }
        
        if (allCompleted) {
            state.isRunning = false;
            return res.json({
                success: true,
                finished: true,
                reason: 'success',
                message: `🎉 完成所有目标！最终存款：${state.currentMoney.toLocaleString()}元`,
                state: getClientState()
            });
        }
        
        return res.json({
            success: true,
            finished: false,
            log: logEntry,
            paused: state.isPaused && state.isWaitingForResume,  // 告诉前端这天已完成，但已暂停
            state: getClientState()
        });
    }
});

function getClientState() {
    const s = simulationState;
    const pressureInfo = calculateRealPressure(s);
    return {
        isRunning: s.isRunning,
        isPaused: s.isPaused,
        isWaitingForResume: s.isWaitingForResume,
        dayCount: s.dayCount,
        currentAge: s.currentAge,
        currentMoney: s.currentMoney,
        currentDayInYear: s.currentDayInYear,
        targets: s.targets,
        logs: s.logs.slice(-30),
        pressure: pressureInfo,
        stats: s.stats,
        history: s.history
    };
}

app.get('/state', (req, res) => {
    res.json(getClientState());
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`服务器运行在 http://localhost:${PORT}`);
    console.log(`使用AI决策：${process.env.SILICONFLOW_API_KEY ? '已配置' : '未配置API密钥'}`);
});