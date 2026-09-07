import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { styles } from '@/theme';

export function ChatComposer() { const [value, setValue] = useState(''); return <View style={styles.composer}><TextInput value={value} onChangeText={setValue} style={styles.composerInput} placeholder="输入给 uBuddy 的指令" multiline /><Pressable style={styles.primaryButton} onPress={() => setValue('')}><Text style={styles.primaryText}>发送</Text></Pressable></View>; }
